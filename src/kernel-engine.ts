import { createHash } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { vacuumStaleIndexTemporaries } from "./index-manager.js";
import {
  bigintToSafeNumber,
  loadKernelBinding,
  nativeKernelErrorCode,
  type NativeBuildStats,
  type NativeBuildWithSourceDigestStats,
  type NativeKernelBinding,
  type NativeKernelIndex,
  type NativeOpenStats,
  type NativeVerifiedMatch,
} from "./kernel-binding.js";
import { runCommand, type CommandResult } from "./process.js";
import { listRipgrepFiles, runRipgrep } from "./rg.js";
import type { SearchMatch, SearchMetadata, SearchRequest } from "./types.js";

const MANIFEST_SCHEMA = "pi-fast-grep-kernel-manifest/v2";
const SESSION_WORKTREE_ENGINES = new WeakSet<object>();

interface KernelManifest {
  schema: typeof MANIFEST_SCHEMA;
  root: string;
  head: string;
  universeSha256: string;
  contentSha256: string;
  indexSha256: string;
  files: number;
  addonSha256: string;
  bindingAbiVersion: number;
}

interface CleanSnapshot {
  head: string;
  universeSha256: string;
  files: number;
}

interface CapturedSource {
  paths: string[];
  identity: CleanSnapshot & { contentSha256: string };
}

interface CapturedSourceMetadata {
  paths: string[];
  identity: CleanSnapshot;
}

export interface KernelSearchTimings {
  totalMs: number;
  nativeQueryMs?: number;
  materializeMs?: number;
  nativeVerifyMs?: number;
  verifyMs?: number;
  fallbackMs?: number;
}

export type KernelFreshnessMode = "verified" | "agent_loop_serialized_v1";

export interface KernelSearchMetadata
  extends Omit<
    SearchMetadata,
    "requestedBackend" | "actualBackend" | "timings"
  > {
  requestedBackend: "kernel-dev";
  actualBackend: "kernel" | "rg_fallback";
  kernelFreshnessMode: KernelFreshnessMode;
  kernelCandidateFiles?: number;
  kernelVerifiedFiles?: number;
  kernelOccurrences?: number;
  timings: KernelSearchTimings;
}

export interface KernelSearchResult {
  matches: SearchMatch[];
  metadata: KernelSearchMetadata;
}

export interface KernelStartResult {
  reusedPersistentGeneration: boolean;
  files: number;
  buildStats?: NativeBuildStats;
  openStats: NativeOpenStats;
}

export interface OptInKernelEngineOptions {
  root: string;
  addonPath: string;
  indexPath?: string;
  /**
   * Enables the O(1) Agent-loop freshness barrier. The Pi host must call
   * `mark()` synchronously before dispatching every write/edit/bash or unknown
   * potentially mutating tool, must not run an unmarked external writer, and
   * must never re-arm this engine after a mark. Without this explicit
   * capability the engine keeps the slower full-content verification before
   * and after every query.
   */
  trustedMutationFeed?: KernelMutationFeed;
  /**
   * Builds one non-persistent generation from the current worktree, including
   * tracked modifications and untracked files. This is only safe behind the
   * trusted Agent-loop mutation barrier and is used to recover after a Pi tool
   * finishes mutating the workspace.
   */
  sessionWorktreeSnapshot?: boolean;
}

export class KernelMutationFeed {
  private readonly listeners = new Set<(reason: string) => void>();
  private firstReason: string | undefined;

  get marked(): boolean {
    return this.firstReason !== undefined;
  }

  get reason(): string | undefined {
    return this.firstReason;
  }

  mark(reason = "kernel_host_mutation"): void {
    this.firstReason ??= reason;
    for (const listener of this.listeners) listener(this.firstReason);
  }

  subscribe(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);
    if (this.firstReason !== undefined) listener(this.firstReason);
    return () => this.listeners.delete(listener);
  }
}

class KernelSnapshotChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelSnapshotChangedError";
  }
}

function compareMatches(left: SearchMatch, right: SearchMatch): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.lineNumber !== right.lineNumber) return left.lineNumber - right.lineNumber;
  return (left.ranges[0]?.absoluteStart ?? 0) - (right.ranges[0]?.absoluteStart ?? 0);
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function isVisibleCandidate(candidate: string): boolean {
  return !candidate.split("/").some((segment) => segment.startsWith("."));
}

interface LiteralGlob {
  basename: boolean;
  segments: readonly string[];
}

function compileLiteralGlob(pattern: string): LiteralGlob | undefined {
  if (
    pattern.length === 0
    || pattern.startsWith("/")
    || pattern.endsWith("/")
    || /[!?[\]{}\\\0\r\n]/u.test(pattern)
  ) {
    return undefined;
  }
  const basename = !pattern.includes("/");
  const segments = pattern.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0 || segment === "." || segment === "..") return undefined;
    if (segment === "**") {
      if (
        basename
        || index + 1 === segments.length
        || segments[index - 1] === "**"
      ) {
        return undefined;
      }
    } else if (segment.includes("**")) {
      return undefined;
    }
  }
  return { basename, segments };
}

function literalGlobSegmentMatches(
  pattern: string,
  value: string,
  valueStart = 0,
): boolean {
  let patternIndex = 0;
  let valueIndex = valueStart;
  let starIndex = -1;
  let starValueIndex = valueStart;
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      starValueIndex = valueIndex;
    } else if (pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function literalGlobMatches(glob: LiteralGlob, candidate: string): boolean {
  if (glob.basename) {
    return literalGlobSegmentMatches(
      glob.segments[0] as string,
      candidate,
      candidate.lastIndexOf("/") + 1,
    );
  }
  const pathSegments = candidate.split("/");
  let previous = Array.from({ length: pathSegments.length + 1 }, (_, index) => index === 0);
  for (const segment of glob.segments) {
    const current = Array<boolean>(pathSegments.length + 1).fill(false);
    if (segment === "**") {
      current[0] = previous[0] as boolean;
      for (let index = 1; index <= pathSegments.length; index += 1) {
        current[index] = (previous[index] as boolean) || (current[index - 1] as boolean);
      }
    } else {
      for (let index = 1; index <= pathSegments.length; index += 1) {
        current[index] = (previous[index - 1] as boolean)
          && literalGlobSegmentMatches(segment, pathSegments[index - 1] as string);
      }
    }
    previous = current;
  }
  return previous[pathSegments.length] as boolean;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === "AbortError");
}

function supportFailure(request: SearchRequest): string | undefined {
  if (request.multiline === true) return "kernel_multiline_unsupported";
  if (request.noIgnore === true) return "kernel_no_ignore_unsupported";
  if (request.limit !== undefined && request.limit !== null && !Number.isFinite(request.limit)) {
    return "kernel_nonfinite_limit";
  }
  if (request.literal !== true) {
    if (request.ignoreCase === true) return "kernel_case_fold_unsupported";
    if (request.glob !== undefined) return "kernel_glob_unsupported";
    if (request.path !== undefined && request.path !== ".") {
      return "kernel_path_filter_unsupported";
    }
    return undefined;
  }
  if (request.ignoreCase === true && /[^\x00-\x7f]/u.test(request.pattern)) {
    return "kernel_case_fold_non_ascii_pattern";
  }
  if (request.glob !== undefined && compileLiteralGlob(request.glob) === undefined) {
    return "kernel_glob_unsupported";
  }
  const bytes = Buffer.from(request.pattern, "utf8");
  if (bytes.length < 3) return "kernel_literal_shorter_than_three_bytes";
  if (bytes.includes(0) || bytes.includes(10) || bytes.includes(13)) {
    return "kernel_multiline_literal_unsupported";
  }
  return undefined;
}

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
}

function hashLengthFramed(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    updateLengthFramed(hash, value);
  }
  return hash.digest("hex");
}

function sameSourceIdentity(
  left: CleanSnapshot & { contentSha256: string },
  right: CleanSnapshot & { contentSha256: string },
): boolean {
  return left.head === right.head
    && left.universeSha256 === right.universeSha256
    && left.contentSha256 === right.contentSha256
    && left.files === right.files;
}

function validatedBuildSourceDigest(
  buildStats: NativeBuildWithSourceDigestStats,
  expectedFiles: number,
): string {
  if (
    typeof buildStats.contentSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(buildStats.contentSha256)
    || buildStats.files !== BigInt(expectedFiles)
    || typeof buildStats.sourceBytes !== "bigint"
    || buildStats.sourceBytes < 0n
  ) {
    throw new KernelSnapshotChangedError(
      "native fused build returned an invalid source identity",
    );
  }
  return buildStats.contentSha256;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
  );
}

function ignoredWatcherPath(value: string): boolean {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//u, "");
  return normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized === ".pi"
    || normalized === ".pi/index"
    || normalized.startsWith(".pi/index/")
    || normalized === ".fast-grep"
    || normalized.startsWith(".fast-grep/");
}

function materializeVerifiedMatches(
  root: string,
  nativeMatches: readonly NativeVerifiedMatch[],
): SearchMatch[] {
  return nativeMatches.map((match) => {
    const absolutePath = path.resolve(root, match.path);
    if (!isWithin(root, absolutePath)) {
      throw new KernelSnapshotChangedError(
        `kernel verifier returned an escaping path: ${match.path}`,
      );
    }
    const lineNumber = bigintToSafeNumber(match.lineNumber, `${match.path}.lineNumber`);
    if (lineNumber < 1) {
      throw new KernelSnapshotChangedError(
        `kernel verifier returned an invalid line number: ${match.path}`,
      );
    }
    const ranges = match.ranges.map((range) => {
      const absoluteStart = bigintToSafeNumber(
        range.absoluteStart,
        `${match.path}.absoluteStart`,
      );
      const absoluteEnd = bigintToSafeNumber(
        range.absoluteEnd,
        `${match.path}.absoluteEnd`,
      );
      const lineStart = bigintToSafeNumber(range.lineStart, `${match.path}.lineStart`);
      const lineEnd = bigintToSafeNumber(range.lineEnd, `${match.path}.lineEnd`);
      if (absoluteEnd < absoluteStart || lineEnd < lineStart) {
        throw new KernelSnapshotChangedError(
          `kernel verifier returned an invalid range: ${match.path}`,
        );
      }
      return { absoluteStart, absoluteEnd, lineStart, lineEnd };
    });
    if (ranges.length === 0) {
      throw new KernelSnapshotChangedError(
        `kernel verifier returned a matching line without ranges: ${match.path}`,
      );
    }
    return {
      path: match.path,
      absolutePath,
      lineNumber,
      lineText: match.lineText,
      ranges,
      before: match.before,
      after: match.after,
    };
  });
}

async function resolveLiteralSearchRoot(
  root: string,
  canonicalRoot: string,
  requestedPath: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (requestedPath === undefined || requestedPath === ".") return root;
  const searchRoot = path.resolve(root, requestedPath);
  if (!isWithin(root, searchRoot)) {
    throw new KernelSnapshotChangedError("literal search path escapes the repository root");
  }
  const metadata = await lstat(searchRoot);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
    throw new KernelSnapshotChangedError("literal search path is not a regular file or directory");
  }
  const canonicalSearchRoot = await realpath(searchRoot);
  if (!isWithin(canonicalRoot, canonicalSearchRoot)) {
    throw new KernelSnapshotChangedError("literal search path resolves outside the repository root");
  }
  signal?.throwIfAborted();
  return searchRoot;
}

async function readRegularFileWithinRoot(
  root: string,
  canonicalRoot: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const absolutePath = path.resolve(root, relativePath);
  if (!isWithin(root, absolutePath)) {
    throw new KernelSnapshotChangedError(`kernel path escapes root: ${relativePath}`);
  }
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new KernelSnapshotChangedError(`kernel path is not a regular file: ${relativePath}`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (!isWithin(canonicalRoot, canonicalPath)) {
    throw new KernelSnapshotChangedError(`kernel path resolves outside root: ${relativePath}`);
  }
  const content = await readFile(
    canonicalPath,
    signal === undefined ? undefined : { signal },
  );
  const after = await lstat(absolutePath);
  const afterCanonicalPath = await realpath(absolutePath);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || canonicalPath !== afterCanonicalPath
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    throw new KernelSnapshotChangedError(`kernel path changed while reading: ${relativePath}`);
  }
  return content;
}

async function hashSourceContents(
  root: string,
  canonicalRoot: string,
  relativePaths: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    signal?.throwIfAborted();
    updateLengthFramed(hash, relativePath);
    updateLengthFramed(
      hash,
      await readRegularFileWithinRoot(root, canonicalRoot, relativePath, signal),
    );
  }
  return hash.digest("hex");
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(
    filePath,
    signal === undefined ? undefined : { signal },
  );
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class OptInKernelEngine {
  readonly root: string;
  readonly indexPath: string;

  private readonly addonPath: string;
  private readonly manifestPath: string;
  private readonly trustedMutationFeed: KernelMutationFeed | undefined;
  private readonly freshnessMode: KernelFreshnessMode;
  private index: NativeKernelIndex | undefined;
  private watcher: FSWatcher | undefined;
  private mutationUnsubscribe: (() => void) | undefined;
  private canonicalRoot: string | undefined;
  private sourceSnapshot: (CleanSnapshot & { contentSha256: string }) | undefined;
  private indexedFiles = 0;
  private invalidReason: string | undefined;
  private generation = 0;
  private nextRegexJobId = 1;
  private permanentlyInvalidated = false;

  constructor(options: OptInKernelEngineOptions) {
    this.root = path.resolve(options.root);
    this.addonPath = options.addonPath;
    this.trustedMutationFeed = options.trustedMutationFeed;
    if (options.sessionWorktreeSnapshot === true && this.trustedMutationFeed === undefined) {
      throw new Error("session worktree snapshots require a trusted mutation feed");
    }
    if (options.sessionWorktreeSnapshot === true) SESSION_WORKTREE_ENGINES.add(this);
    this.freshnessMode =
      options.trustedMutationFeed === undefined
        ? "verified"
        : "agent_loop_serialized_v1";
    this.indexPath = path.resolve(
      options.indexPath ?? path.join(this.root, ".pi", "index", "kernel-v1.pfg"),
    );
    const relativeIndexPath = path.relative(this.root, this.indexPath);
    if (
      relativeIndexPath === ""
      || (
        relativeIndexPath !== ".."
        && !relativeIndexPath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativeIndexPath)
        && !relativeIndexPath.startsWith(`.pi${path.sep}index${path.sep}`)
      )
    ) {
      throw new Error(
        "kernel indexPath inside the workspace must be below the permanently excluded .pi/index directory",
      );
    }
    this.manifestPath = `${this.indexPath}.manifest.json`;
  }

  async start(signal?: AbortSignal): Promise<KernelStartResult> {
    const sessionWorktreeSnapshot = SESSION_WORKTREE_ENGINES.has(this);
    signal?.throwIfAborted();
    if (
      this.trustedMutationFeed !== undefined
      && (this.permanentlyInvalidated || this.trustedMutationFeed.marked)
    ) {
      throw new KernelSnapshotChangedError(
        "an agent-loop kernel instance cannot be re-armed after a mutation mark",
      );
    }
    this.stopWatcher();
    this.stopMutationFeed();
    this.index?.close();
    this.index = undefined;
    this.sourceSnapshot = undefined;
    this.invalidReason = undefined;
    this.generation += 1;
    this.canonicalRoot = undefined;
    this.installMutationFeed();
    const sourceGeneration = this.generation;

    try {
      await vacuumStaleIndexTemporaries(path.dirname(this.indexPath));
      this.canonicalRoot = await realpath(this.root);
      // A recovery generation starts immediately after a known Pi mutation.
      // A newly-created FSEvents stream can replay that already-completed event
      // and spuriously invalidate the new snapshot. Its trusted host feed is the
      // authoritative barrier; clean startup generations retain the watcher as
      // a bonus signal for unmarked external changes.
      //
      // Correctness does not rest on this watcher, which is why it can wait
      // until the workspace is known to be a repository at all. Without a
      // trusted feed the capture is re-taken and compared by identity before
      // the index is adopted; with one, the host's mark is the barrier. The
      // watcher only shortens the window in which an unmarked outside write
      // goes unnoticed -- and an unmarked outside write is already outside the
      // freshness guarantee.
      //
      // Skipping non-repositories matters: the kernel only serves a clean Git
      // snapshot, so a recursive watch over, say, a home directory buys
      // nothing and can exhaust the platform's watch descriptors (issue #1).
      if (!sessionWorktreeSnapshot && await this.rootIsGitRepository(signal)) {
        this.installWatcher();
      }
      const binding = loadKernelBinding(this.addonPath);
      const addonSha256 = await hashFile(this.addonPath, signal);
      const fusedColdEligible =
        this.trustedMutationFeed !== undefined
        && signal === undefined
        && process.platform !== "win32";
      let metadata: CapturedSourceMetadata;
      let before: CapturedSource | undefined;
      let manifest: KernelManifest | undefined;
      if (sessionWorktreeSnapshot) {
        if (!fusedColdEligible) {
          throw new KernelSnapshotChangedError(
            "session worktree snapshots require the fused trusted build path",
          );
        }
        const paths = await this.listUniverse(signal);
        metadata = {
          paths,
          identity: {
            head: "session-worktree-v1",
            universeSha256: hashLengthFramed(paths),
            files: paths.length,
          },
        };
      } else if (fusedColdEligible) {
        metadata = await this.captureFusedSourceMetadata();
        if (this.generation !== sourceGeneration) {
          throw new KernelSnapshotChangedError("workspace changed during source capture");
        }
        manifest = await this.readManifest();
        if (
          manifest !== undefined
          && manifest.root === this.canonicalRoot
          && manifest.head === metadata.identity.head
          && manifest.universeSha256 === metadata.identity.universeSha256
          && manifest.files === metadata.identity.files
          && manifest.addonSha256 === addonSha256
          && manifest.bindingAbiVersion === binding.BINDING_ABI_VERSION
        ) {
          before = await this.captureSourceContents(metadata, signal, binding);
        }
      } else {
        before = await this.captureSource(signal, binding);
        metadata = {
          paths: before.paths,
          identity: {
            head: before.identity.head,
            universeSha256: before.identity.universeSha256,
            files: before.identity.files,
          },
        };
        manifest = await this.readManifest();
      }
      if (this.generation !== sourceGeneration) {
        throw new KernelSnapshotChangedError("workspace changed during source capture");
      }

      if (
        before !== undefined
        && manifest !== undefined
        && manifest.root === this.canonicalRoot
        && manifest.head === before.identity.head
        && manifest.universeSha256 === before.identity.universeSha256
        && manifest.contentSha256 === before.identity.contentSha256
        && manifest.files === before.identity.files
        && manifest.addonSha256 === addonSha256
        && manifest.bindingAbiVersion === binding.BINDING_ABI_VERSION
      ) {
        let opened: NativeKernelIndex | undefined;
        try {
          const indexSha256 = await hashFile(this.indexPath, signal);
          if (indexSha256 !== manifest.indexSha256) {
            throw new KernelSnapshotChangedError("persisted index digest does not match manifest");
          }
          signal?.throwIfAborted();
          opened = binding.KernelIndex.open(this.indexPath);
          if (this.trustedMutationFeed === undefined) {
            const afterOpen = await this.captureSource(signal, binding);
            if (
              this.generation !== sourceGeneration
              || !sameSourceIdentity(before.identity, afterOpen.identity)
            ) {
              throw new KernelSnapshotChangedError(
                "workspace changed while opening kernel index",
              );
            }
          } else if (
            this.generation !== sourceGeneration
            || this.invalidReason !== undefined
            || this.trustedMutationFeed.marked
          ) {
            throw new KernelSnapshotChangedError(
              "agent-loop generation changed while opening kernel index",
            );
          }
          this.replaceIndex(opened, before.identity);
          return {
            reusedPersistentGeneration: true,
            files: before.identity.files,
            openStats: opened.openStats,
          };
        } catch (error) {
          opened?.close();
          if (isAbort(error, signal)) throw error;
          // A stale, mismatched, or corrupt generation is rebuilt only after
          // its old manifest has been durably invalidated below.
        }
      }

      await this.removeManifestDurably();
      if (this.generation !== sourceGeneration) {
        throw new KernelSnapshotChangedError("workspace changed before kernel build");
      }
      let buildStats: NativeBuildStats;
      let buildIdentity: CleanSnapshot & { contentSha256: string };
      if (fusedColdEligible) {
        const fusedBuildStats = binding.buildKernelIndexWithSourceDigest(
          this.root,
          metadata.paths,
          this.indexPath,
        );
        buildStats = fusedBuildStats;
        const contentSha256 = validatedBuildSourceDigest(
          fusedBuildStats,
          metadata.paths.length,
        );
        if (
          before !== undefined
          && before.identity.contentSha256 !== contentSha256
        ) {
          throw new KernelSnapshotChangedError(
            "fused build source digest does not match the pre-build capture",
          );
        }
        buildIdentity = { ...metadata.identity, contentSha256 };
        // The isolated Pi start contract excludes external writers, dispatches
        // no tools while this synchronous native build is running, and marks
        // every legal mutator before execution. Content-first v2 derives the
        // digest, postings, and persisted payload from the same captured
        // buffer; the v1 fallback retains its independent second-pass BLAKE3
        // check before either format is durably published.
        if (
          this.generation !== sourceGeneration
          || this.invalidReason !== undefined
          || this.trustedMutationFeed?.marked === true
        ) {
          throw new KernelSnapshotChangedError(
            "agent-loop generation changed while building kernel index",
          );
        }
      } else {
        if (before === undefined) {
          throw new KernelSnapshotChangedError(
            "pre-build source identity is unavailable",
          );
        }
        buildStats = binding.buildKernelIndex(
          this.root,
          before.paths,
          this.indexPath,
        );
        signal?.throwIfAborted();
        const afterBuild = await this.captureSource(signal, binding);
        if (
          this.generation !== sourceGeneration
          || !sameSourceIdentity(before.identity, afterBuild.identity)
        ) {
          throw new KernelSnapshotChangedError("workspace changed while building kernel index");
        }
        buildIdentity = before.identity;
      }
      const indexSha256 = sessionWorktreeSnapshot
        ? undefined
        : await hashFile(this.indexPath, signal);
      const opened = binding.KernelIndex.open(this.indexPath);
      const openStats = opened.openStats;
      if (this.generation !== sourceGeneration) {
        opened.close();
        throw new KernelSnapshotChangedError("workspace changed while publishing kernel index");
      }
      this.replaceIndex(opened, buildIdentity);
      const publishedGeneration = this.generation;
      if (indexSha256 !== undefined) {
        await this.writeManifest({
          schema: MANIFEST_SCHEMA,
          root: this.canonicalRoot,
          head: buildIdentity.head,
          universeSha256: buildIdentity.universeSha256,
          contentSha256: buildIdentity.contentSha256,
          indexSha256,
          files: buildIdentity.files,
          addonSha256,
          bindingAbiVersion: binding.BINDING_ABI_VERSION,
        });
      }
      if (
        this.generation !== publishedGeneration
        || this.index !== opened
        || this.invalidReason !== undefined
      ) {
        throw new KernelSnapshotChangedError(
          "workspace changed while publishing kernel manifest",
        );
      }

      return {
        reusedPersistentGeneration: false,
        files: buildIdentity.files,
        buildStats,
        openStats,
      };
    } catch (error) {
      if (nativeKernelErrorCode(error) === "PFG_SOURCE_TOO_LARGE") {
        try {
          await this.removePersistedGeneration();
        } finally {
          this.markWorkspaceChanged("kernel_start_failed");
        }
      } else {
        this.markWorkspaceChanged("kernel_start_failed");
      }
      throw error;
    }
  }

  markWorkspaceChanged(reason = "workspace_changed"): void {
    this.generation += 1;
    this.invalidReason ??= reason;
    if (this.trustedMutationFeed !== undefined) this.permanentlyInvalidated = true;
    this.sourceSnapshot = undefined;
    this.index?.close();
    this.index = undefined;
  }

  close(): boolean {
    this.generation += 1;
    this.stopWatcher();
    this.stopMutationFeed();
    const closed = this.index?.close() ?? false;
    this.index = undefined;
    this.sourceSnapshot = undefined;
    this.invalidReason ??= "kernel_closed";
    return closed;
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<KernelSearchResult> {
    const started = performance.now();
    signal?.throwIfAborted();
    const unsupported = supportFailure(request);
    if (unsupported !== undefined) {
      return this.fallback(request, unsupported, started, signal);
    }
    if (this.invalidReason !== undefined) {
      return this.fallback(request, this.invalidReason, started, signal);
    }
    if (this.index === undefined) {
      return this.fallback(request, "kernel_not_started", started, signal);
    }
    const initialHandle = this.index;
    const initialGeneration = this.generation;
    if (
      !(await this.querySnapshotMatches(
        initialGeneration,
        initialHandle,
        signal,
      ))
    ) {
      const reason = this.invalidReason ?? "kernel_snapshot_changed";
      if (this.invalidReason === undefined) this.markWorkspaceChanged(reason);
      return this.fallback(request, reason, started, signal);
    }
    if (
      this.index === undefined
      || this.index !== initialHandle
      || this.invalidReason !== undefined
    ) {
      return this.fallback(
        request,
        this.invalidReason ?? "kernel_generation_changed",
        started,
        signal,
      );
    }

    const handle = initialHandle;
    const generation = initialGeneration;
    if (request.literal !== true) {
      return this.searchRegexCandidates(
        request,
        handle,
        generation,
        started,
        signal,
      );
    }
    let literalSearchRoot: string | undefined;
    let literalPathRoot: string | undefined;
    const literalGlob = request.glob === undefined
      ? undefined
      : compileLiteralGlob(request.glob);
    if (request.glob !== undefined && literalGlob === undefined) {
      return this.fallback(request, "kernel_glob_unsupported", started, signal);
    }
    if (request.path !== undefined && request.path !== ".") {
      try {
        if (this.canonicalRoot === undefined) {
          throw new KernelSnapshotChangedError("canonical repository root is unavailable");
        }
        literalSearchRoot = await resolveLiteralSearchRoot(
          this.root,
          this.canonicalRoot,
          request.path,
          signal,
        );
        literalPathRoot = path
          .relative(this.root, literalSearchRoot)
          .split(path.sep)
          .join("/");
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        return this.fallback(request, "kernel_path_filter_unsupported", started, signal);
      }
    }
    let native;
    try {
      native = request.ignoreCase === true
        ? handle.queryLiteral(request.pattern, literalPathRoot, request.glob, true)
        : handle.queryLiteral(request.pattern, literalPathRoot, request.glob);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return this.fallback(
        request,
        nativeKernelErrorCode(error) ?? "kernel_query_error",
        started,
        signal,
      );
    }
    if (
      native.requiresFallback
      !== (
        native.binaryMatchFiles.length > 0
        || native.unsafeTranscodedFiles.length > 0
        || (request.ignoreCase === true && native.unsafeCaseFoldFiles.length > 0)
      )
      || BigInt(native.occurrences.length) !== native.totalOccurrences
    ) {
      return this.fallback(request, "kernel_occurrence_count_mismatch", started, signal);
    }
    const requestAllows = (candidate: string) =>
      (request.hidden !== false || isVisibleCandidate(candidate))
      && (
        literalSearchRoot === undefined
        || isWithin(literalSearchRoot, path.resolve(this.root, candidate))
      )
      && (literalGlob === undefined || literalGlobMatches(literalGlob, candidate));
    const ordinaryOccurrences = native.occurrences.filter((occurrence) =>
      requestAllows(occurrence.path));
    const binaryMatchFiles = native.binaryMatchFiles.filter(requestAllows);
    const unsafeTranscodedFiles = native.unsafeTranscodedFiles.filter(requestAllows);
    const unsafeCaseFoldFiles = request.ignoreCase === true
      ? native.unsafeCaseFoldFiles.filter(requestAllows)
      : [];
    const visibleTranscodedFiles = native.transcodedCandidateFiles.filter(requestAllows);
    const visibleUtf8BomFiles = native.utf8BomCandidateFiles.filter(requestAllows);
    if (unsafeTranscodedFiles.length > 0) {
      return this.fallback(request, "kernel_transcoded_binary", started, signal);
    }
    if (unsafeCaseFoldFiles.length > 0) {
      return this.fallback(request, "kernel_unicode_case_fold", started, signal);
    }
    if (binaryMatchFiles.length > 0) {
      return this.fallback(request, "kernel_binary_match", started, signal);
    }

    const beforeCount = normalizeCount(request.beforeContext ?? request.context, 0);
    const afterCount = normalizeCount(request.afterContext ?? request.context, 0);
    const limit =
      request.limit === null
        ? undefined
        : Math.max(0, Math.floor(request.limit ?? 100));
    const utf8BomFiles = new Set(visibleUtf8BomFiles);
    if (
      new Set(native.utf8BomCandidateFiles).size !== native.utf8BomCandidateFiles.length
      || native.utf8BomCandidateFiles.some(
        (candidate) => !native.transcodedCandidateFiles.includes(candidate),
      )
    ) {
      return this.fallback(request, "kernel_literal_verify_incomplete", started, signal);
    }
    const ordinaryPaths = [
      ...new Set([
        ...ordinaryOccurrences.map((value) => value.path),
        ...visibleUtf8BomFiles,
      ]),
    ].sort();
    const transcodedCandidateFiles = visibleTranscodedFiles.filter(
      (candidate) => !utf8BomFiles.has(candidate),
    );
    const verifyStarted = performance.now();
    const jobId = this.nextRegexJobId;
    this.nextRegexJobId = jobId === 0xffff_ffff ? 1 : jobId + 1;
    const cancelJob = () => {
      try {
        handle.cancelRegexVerification(jobId);
      } catch {
        // The Promise and generation fence below remain authoritative.
      }
    };
    signal?.addEventListener("abort", cancelJob, { once: true });
    let verified;
    try {
      const verifying = request.ignoreCase === true
        ? handle.verifyLiteralCandidates(
          request.pattern,
          ordinaryPaths,
          beforeCount,
          afterCount,
          jobId,
          limit,
          true,
        )
        : handle.verifyLiteralCandidates(
          request.pattern,
          ordinaryPaths,
          beforeCount,
          afterCount,
          jobId,
          limit,
        );
      if (signal?.aborted === true) cancelJob();
      verified = await verifying;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return this.fallback(
        request,
        nativeKernelErrorCode(error) ?? "kernel_literal_verify_error",
        started,
        signal,
      );
    } finally {
      signal?.removeEventListener("abort", cancelJob);
    }

    let allMatches: SearchMatch[];
    let ordinaryTotal: number;
    let occurrenceCount: number;
    let indexedOccurrenceCount: number;
    let verifiedFiles: number;
    let nativeVerifyMs: number;
    const materializeStarted = performance.now();
    try {
      allMatches = materializeVerifiedMatches(this.root, verified.matches);
      ordinaryTotal = bigintToSafeNumber(verified.totalMatches, "totalMatches");
      occurrenceCount = bigintToSafeNumber(
        verified.totalOccurrences,
        "totalOccurrences",
      );
      indexedOccurrenceCount = bigintToSafeNumber(
        verified.indexedOccurrences,
        "indexedOccurrences",
      );
      verifiedFiles = bigintToSafeNumber(verified.verifiedFiles, "verifiedFiles");
      nativeVerifyMs =
        bigintToSafeNumber(verified.queryDurationNs, "queryDurationNs") / 1_000_000;
    } catch {
      return this.fallback(request, "kernel_range_unsafe", started, signal);
    }
    const materializeMs = performance.now() - materializeStarted;
    if (
      verifiedFiles !== ordinaryPaths.length
      || verified.matches.length > ordinaryTotal
      || indexedOccurrenceCount !== ordinaryOccurrences.length
      || verified.indexedOccurrences !== BigInt(ordinaryOccurrences.length)
      || verified.truncated !== (verified.matches.length < ordinaryTotal)
    ) {
      return this.fallback(request, "kernel_literal_verify_incomplete", started, signal);
    }
    let transcodedTotal = 0;
    if (transcodedCandidateFiles.length > 0) {
      const transcoded = await runRipgrep(
        this.root,
        { ...request, limit: null },
        {
          actualBackend: "kernel",
          requestedBackend: "kernel-dev",
          candidates: transcodedCandidateFiles,
          signal,
        },
      );
      transcodedTotal = transcoded.metadata.totalMatches;
      verifiedFiles += transcodedCandidateFiles.length;
      allMatches.push(...transcoded.matches);
    }
    allMatches.sort(compareMatches);
    const totalMatches = ordinaryTotal + transcodedTotal;
    const matches = limit === undefined ? allMatches : allMatches.slice(0, limit);
    const verifyMs = performance.now() - verifyStarted;
    if (
      !(await this.querySnapshotMatches(generation, handle, signal))
      || this.generation !== generation
      || this.index !== handle
      || this.invalidReason !== undefined
    ) {
      const reason = this.invalidReason ?? "kernel_generation_changed";
      if (this.invalidReason === undefined) this.markWorkspaceChanged(reason);
      return this.fallback(request, reason, started, signal);
    }
    if (
      allMatches.length > totalMatches
      || (limit === undefined && allMatches.length !== totalMatches)
    ) {
      return this.fallback(request, "kernel_literal_verify_incomplete", started, signal);
    }
    let candidateFiles: number;
    let nativeQueryMs: number;
    try {
      candidateFiles = bigintToSafeNumber(native.candidateFiles, "candidateFiles");
      nativeQueryMs =
        bigintToSafeNumber(native.queryDurationNs, "queryDurationNs") / 1_000_000;
    } catch {
      return this.fallback(request, "kernel_range_unsafe", started, signal);
    }
    return {
      matches,
      metadata: {
        requestedBackend: "kernel-dev",
        actualBackend: "kernel",
        kernelFreshnessMode: this.freshnessMode,
        dirtyFiles: 0,
        realtimeFiles: 0,
        totalMatches,
        totalMatchesExact: true,
        displayedMatches: matches.length,
        truncated: matches.length < totalMatches,
        indexFilesConsidered: candidateFiles,
        indexFilesLoaded: this.indexedFiles,
        indexMatchCount: occurrenceCount,
        kernelCandidateFiles: candidateFiles,
        kernelVerifiedFiles: verifiedFiles,
        kernelOccurrences: occurrenceCount,
        timings: {
          totalMs: performance.now() - started,
          nativeQueryMs,
          nativeVerifyMs,
          materializeMs,
          verifyMs,
        },
      },
    };
  }

  private async searchRegexCandidates(
    request: SearchRequest,
    handle: NativeKernelIndex,
    generation: number,
    started: number,
    signal?: AbortSignal,
  ): Promise<KernelSearchResult> {
    let native;
    try {
      native = handle.queryRegexCandidates(request.pattern);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return this.fallback(
        request,
        nativeKernelErrorCode(error) ?? "kernel_regex_plan_error",
        started,
        signal,
      );
    }
    if (native === null) {
      return this.fallback(
        request,
        "kernel_regex_no_mandatory_trigram",
        started,
        signal,
      );
    }
    if (
      native.complete !== true
      || !Number.isInteger(native.selectedGram)
      || native.selectedGram < 0
      || native.selectedGram > 0x00ff_ffff
    ) {
      return this.fallback(request, "kernel_regex_plan_incomplete", started, signal);
    }
    if (native.unsafeTranscodedPaths.length > 0) {
      return this.fallback(request, "kernel_transcoded_binary", started, signal);
    }
    if (native.binaryCandidatePaths.length > 0) {
      return this.fallback(request, "kernel_binary_candidate", started, signal);
    }

    let candidateFiles: number;
    let mandatoryGrams: number;
    let nativeQueryMs: number;
    try {
      candidateFiles = bigintToSafeNumber(native.candidateFiles, "candidateFiles");
      mandatoryGrams = bigintToSafeNumber(native.mandatoryGrams, "mandatoryGrams");
      nativeQueryMs =
        bigintToSafeNumber(native.queryDurationNs, "queryDurationNs") / 1_000_000;
    } catch {
      return this.fallback(request, "kernel_range_unsafe", started, signal);
    }
    if (mandatoryGrams === 0) {
      return this.fallback(request, "kernel_regex_plan_incomplete", started, signal);
    }

    const requestAllows = (candidate: string) =>
      request.hidden !== false || isVisibleCandidate(candidate);
    const ordinaryPaths = [
      ...new Set(
        [...native.candidatePaths, ...native.utf8BomCandidatePaths].filter(requestAllows),
      ),
    ].sort();
    const transcodedPaths = [
      ...new Set(native.transcodedCandidatePaths.filter(requestAllows)),
    ].sort();
    const beforeCount = normalizeCount(request.beforeContext ?? request.context, 0);
    const afterCount = normalizeCount(request.afterContext ?? request.context, 0);
    const limit =
      request.limit === null
        ? undefined
        : Math.max(0, Math.floor(request.limit ?? 100));
    const verifyStarted = performance.now();
    let verified;
    const jobId = this.nextRegexJobId;
    this.nextRegexJobId = jobId === 0xffff_ffff ? 1 : jobId + 1;
    const cancelJob = () => {
      try {
        handle.cancelRegexVerification(jobId);
      } catch {
        // The Promise and generation fence below remain authoritative.
      }
    };
    signal?.addEventListener("abort", cancelJob, { once: true });
    try {
      const verifying = handle.verifyRegexCandidates(
        request.pattern,
        ordinaryPaths,
        beforeCount,
        afterCount,
        jobId,
        limit,
      );
      if (signal?.aborted === true) cancelJob();
      verified = await verifying;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return this.fallback(
        request,
        nativeKernelErrorCode(error) ?? "kernel_regex_verify_error",
        started,
        signal,
      );
    } finally {
      signal?.removeEventListener("abort", cancelJob);
    }

    let allMatches: SearchMatch[];
    let ordinaryTotal: number;
    let verifiedFiles: number;
    let nativeVerifyMs: number;
    try {
      allMatches = materializeVerifiedMatches(this.root, verified.matches);
      ordinaryTotal = bigintToSafeNumber(verified.totalMatches, "totalMatches");
      verifiedFiles = bigintToSafeNumber(verified.verifiedFiles, "verifiedFiles");
      nativeVerifyMs =
        bigintToSafeNumber(verified.queryDurationNs, "queryDurationNs") / 1_000_000;
    } catch {
      return this.fallback(request, "kernel_range_unsafe", started, signal);
    }
    if (
      verifiedFiles !== ordinaryPaths.length
      || verified.matches.length > ordinaryTotal
      || verified.truncated !== (verified.matches.length < ordinaryTotal)
    ) {
      return this.fallback(request, "kernel_regex_verify_incomplete", started, signal);
    }
    let transcodedTotal = 0;
    if (transcodedPaths.length > 0) {
      const transcoded = await runRipgrep(
        this.root,
        { ...request, limit: null },
        {
          actualBackend: "kernel",
          requestedBackend: "kernel-dev",
          candidates: transcodedPaths,
          eligiblePaths: new Set(transcodedPaths),
          signal,
        },
      );
      transcodedTotal = transcoded.metadata.totalMatches;
      verifiedFiles += transcodedPaths.length;
      allMatches.push(...transcoded.matches);
    }
    allMatches.sort(compareMatches);
    const totalMatches = ordinaryTotal + transcodedTotal;
    const matches = limit === undefined ? allMatches : allMatches.slice(0, limit);
    const verifyMs = performance.now() - verifyStarted;

    if (
      !(await this.querySnapshotMatches(generation, handle, signal))
      || this.generation !== generation
      || this.index !== handle
      || this.invalidReason !== undefined
    ) {
      const reason = this.invalidReason ?? "kernel_generation_changed";
      if (this.invalidReason === undefined) this.markWorkspaceChanged(reason);
      return this.fallback(request, reason, started, signal);
    }

    if (
      allMatches.length > totalMatches
      || (limit === undefined && allMatches.length !== totalMatches)
    ) {
      return this.fallback(request, "kernel_regex_verify_incomplete", started, signal);
    }
    return {
      matches,
      metadata: {
        requestedBackend: "kernel-dev",
        actualBackend: "kernel",
        kernelFreshnessMode: this.freshnessMode,
        dirtyFiles: 0,
        realtimeFiles: 0,
        totalMatches,
        totalMatchesExact: true,
        displayedMatches: matches.length,
        truncated: matches.length < totalMatches,
        indexFilesConsidered: candidateFiles,
        indexFilesLoaded: this.indexedFiles,
        indexMatchCount: totalMatches,
        kernelCandidateFiles: candidateFiles,
        kernelVerifiedFiles: verifiedFiles,
        timings: {
          totalMs: performance.now() - started,
          nativeQueryMs,
          nativeVerifyMs,
          verifyMs,
        },
      },
    };
  }

  private replaceIndex(
    next: NativeKernelIndex,
    sourceSnapshot: CleanSnapshot & { contentSha256: string },
  ): void {
    const previous = this.index;
    this.generation += 1;
    this.index = next;
    this.sourceSnapshot = sourceSnapshot;
    this.indexedFiles = sourceSnapshot.files;
    this.invalidReason = undefined;
    previous?.close();
  }

  /**
   * Whether the root sits inside a Git repository at all.
   *
   * Deliberately cheap: `rev-parse --git-dir` resolves the repository without
   * walking the tree, so this costs a process launch rather than a scan. A
   * non-repository cannot produce a clean snapshot, so every query there falls
   * back to ripgrep regardless.
   */
  private async rootIsGitRepository(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await runCommand(
        "git",
        ["-C", this.root, "rev-parse", "--git-dir"],
        {
          allowExitCodes: [0, 128, 129],
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return result.code === 0;
    } catch {
      // Git missing or unrunnable is not a reason to fail startup; it just
      // means the watcher is not worth installing.
      return false;
    }
  }

  private installWatcher(): void {
    try {
      const watcher = watch(
        this.root,
        { recursive: true, persistent: false, encoding: "utf8" },
        (_eventType, filename) => {
          if (filename !== null && ignoredWatcherPath(filename)) return;
          this.markWorkspaceChanged(
            filename === null ? "kernel_watcher_unknown" : "kernel_workspace_event",
          );
        },
      );
      this.watcher = watcher;
      // `on`, not `once`. A recursive watch reports a failure per directory it
      // cannot cover, so a one-shot listener detaches after the first one and
      // leaves the rest unhandled -- which takes the host process down. Hitting
      // the inotify limit under a large tree emits many.
      watcher.on("error", () => {
        if (this.watcher !== watcher) return;
        this.markWorkspaceChanged("kernel_watcher_error");
        // Coverage is already incomplete, and on Linux a live watcher keeps
        // holding inotify descriptors, so release it. Searches fall back to
        // ripgrep from here, which is correct, just not accelerated.
        this.watcher = undefined;
        watcher.close();
      });
      watcher.once("close", () => {
        if (this.watcher !== watcher) return;
        this.watcher = undefined;
        this.markWorkspaceChanged("kernel_watcher_closed");
      });
    } catch (error) {
      this.markWorkspaceChanged("kernel_watcher_unavailable");
      throw new KernelSnapshotChangedError(
        `kernel freshness watcher is unavailable: ${String(error)}`,
      );
    }
  }

  private installMutationFeed(): void {
    if (this.trustedMutationFeed === undefined) return;
    this.mutationUnsubscribe = this.trustedMutationFeed.subscribe((reason) => {
      this.markWorkspaceChanged(reason);
    });
  }

  private stopMutationFeed(): void {
    this.mutationUnsubscribe?.();
    this.mutationUnsubscribe = undefined;
  }

  private stopWatcher(): void {
    const watcher = this.watcher;
    this.watcher = undefined;
    watcher?.removeAllListeners();
    watcher?.close();
  }

  private async captureSource(
    signal?: AbortSignal,
    binding?: NativeKernelBinding,
  ): Promise<CapturedSource> {
    return this.captureSourceContents(
      await this.captureSourceMetadata(signal),
      signal,
      binding,
    );
  }

  private async captureSourceMetadata(
    signal?: AbortSignal,
  ): Promise<CapturedSourceMetadata> {
    if (this.canonicalRoot === undefined) {
      throw new KernelSnapshotChangedError("canonical repository root is unavailable");
    }
    const paths = await this.listUniverse(signal);
    const snapshot = await this.cleanSnapshot(paths, signal);
    if (snapshot === undefined) {
      throw new KernelSnapshotChangedError(
        "kernel requires a clean Git snapshot; dirty or non-Git workspaces use ripgrep",
      );
    }
    return { paths, identity: snapshot };
  }

  private async captureFusedSourceMetadata(): Promise<CapturedSourceMetadata> {
    if (this.canonicalRoot === undefined) {
      throw new KernelSnapshotChangedError("canonical repository root is unavailable");
    }
    const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const [pathsResult, headResult, statusResult] = await Promise.allSettled([
      this.listUniverse(),
      this.readFusedGitHead(environment),
      this.readFusedGitStatus(environment),
    ] as const);

    if (pathsResult.status === "rejected") throw pathsResult.reason;
    if (headResult.status === "rejected") throw headResult.reason;
    let snapshot: CleanSnapshot | undefined;
    if (headResult.value.code === 0) {
      if (statusResult.status === "rejected") throw statusResult.reason;
      if (statusResult.value.stdout.length === 0) {
        snapshot = {
          head: headResult.value.stdout.trim(),
          universeSha256: hashLengthFramed(pathsResult.value),
          files: pathsResult.value.length,
        };
      }
    }
    if (snapshot === undefined) {
      throw new KernelSnapshotChangedError(
        "kernel requires a clean Git snapshot; dirty or non-Git workspaces use ripgrep",
      );
    }
    return { paths: pathsResult.value, identity: snapshot };
  }

  private async captureSourceContents(
    metadata: CapturedSourceMetadata,
    signal?: AbortSignal,
    binding?: NativeKernelBinding,
  ): Promise<CapturedSource> {
    if (this.canonicalRoot === undefined) {
      throw new KernelSnapshotChangedError("canonical repository root is unavailable");
    }
    const { paths, identity } = metadata;
    let contentSha256: string;
    if (
      this.trustedMutationFeed !== undefined
      && signal === undefined
      && binding !== undefined
      && process.platform !== "win32"
    ) {
      const digest = binding.hashSourceContents(
        this.root,
        this.canonicalRoot,
        paths,
      );
      if (
        !/^[a-f0-9]{64}$/u.test(digest.contentSha256)
        || digest.files !== BigInt(paths.length)
        || typeof digest.sourceBytes !== "bigint"
        || digest.sourceBytes < 0n
        || typeof digest.durationNs !== "bigint"
        || digest.durationNs < 0n
      ) {
        throw new KernelSnapshotChangedError(
          "native source digest returned an invalid identity",
        );
      }
      contentSha256 = digest.contentSha256;
    } else {
      contentSha256 = await hashSourceContents(
        this.root,
        this.canonicalRoot,
        paths,
        signal,
      );
    }
    signal?.throwIfAborted();
    return {
      paths,
      identity: { ...identity, contentSha256 },
    };
  }

  private async querySnapshotMatches(
    expectedGeneration: number,
    expectedHandle: NativeKernelIndex,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.trustedMutationFeed === undefined) {
      if (!(await this.liveSourceMatches(signal))) return false;
    } else {
      // Node's watcher has no drain contract and is only a bonus invalidation
      // signal here. Correctness in this mode comes from the synchronous host
      // mutation feed and the generation/handle checks around the query.
      signal?.throwIfAborted();
    }
    return this.generation === expectedGeneration
      && this.index === expectedHandle
      && this.invalidReason === undefined;
  }

  private async liveSourceMatches(signal?: AbortSignal): Promise<boolean> {
    const expected = this.sourceSnapshot;
    if (expected === undefined) return false;
    try {
      const current = await this.captureSource(signal);
      return sameSourceIdentity(expected, current.identity);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return false;
    }
  }

  private async listUniverse(signal?: AbortSignal): Promise<string[]> {
    const paths = await listRipgrepFiles(
      this.root,
      {
        pattern: "__pi_fast_grep_kernel_universe__",
        literal: true,
        hidden: true,
        limit: null,
      },
      signal,
    );
    return [...paths].sort();
  }

  private readFusedGitHead(environment: NodeJS.ProcessEnv): Promise<CommandResult> {
    return runCommand(
      "git",
      ["-C", this.root, "rev-parse", "--verify", "HEAD"],
      {
        allowExitCodes: [0, 128],
        env: environment,
      },
    );
  }

  private readFusedGitStatus(environment: NodeJS.ProcessEnv): Promise<CommandResult> {
    return runCommand(
      "git",
      [
        "-C",
        this.root,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      { env: environment },
    );
  }

  private async cleanSnapshot(
    universe: readonly string[],
    signal?: AbortSignal,
  ): Promise<CleanSnapshot | undefined> {
    const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const head = await runCommand(
      "git",
      ["-C", this.root, "rev-parse", "--verify", "HEAD"],
      {
        allowExitCodes: [0, 128],
        env: environment,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (head.code !== 0) return undefined;
    const status = await runCommand(
      "git",
      [
        "-C",
        this.root,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      {
        env: environment,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (status.stdout.length > 0) return undefined;
    return {
      head: head.stdout.trim(),
      universeSha256: hashLengthFramed(universe),
      files: universe.length,
    };
  }

  private async readManifest(): Promise<KernelManifest | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown;
      if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
      ) {
        return undefined;
      }
      const value = parsed as Partial<KernelManifest>;
      if (
        value.schema !== MANIFEST_SCHEMA
        || typeof value.root !== "string"
        || typeof value.head !== "string"
        || typeof value.universeSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.universeSha256)
        || typeof value.contentSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.contentSha256)
        || typeof value.indexSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.indexSha256)
        || typeof value.files !== "number"
        || !Number.isSafeInteger(value.files)
        || value.files < 0
        || typeof value.addonSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.addonSha256)
        || typeof value.bindingAbiVersion !== "number"
      ) {
        return undefined;
      }
      return value as KernelManifest;
    } catch {
      return undefined;
    }
  }

  private async syncManifestDirectory(): Promise<void> {
    let directory;
    try {
      directory = await open(path.dirname(this.manifestPath), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async removeManifestDurably(): Promise<void> {
    await rm(this.manifestPath, { force: true });
    await this.syncManifestDirectory();
  }

  private async removePersistedGeneration(): Promise<void> {
    await rm(this.indexPath, { force: true });
    await rm(this.manifestPath, { force: true });
    await this.syncManifestDirectory();
  }

  private async writeManifest(manifest: KernelManifest): Promise<void> {
    const temporary = `${this.manifestPath}.${process.pid}.${this.generation}.tmp`;
    await rm(temporary, { force: true });
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, this.manifestPath);
      await this.syncManifestDirectory();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async fallback(
    request: SearchRequest,
    reason: string,
    started: number,
    signal?: AbortSignal,
  ): Promise<KernelSearchResult> {
    const result = await runRipgrep(this.root, request, {
      actualBackend: "rg_fallback",
      requestedBackend: "kernel-dev",
      signal,
    });
    return {
      matches: result.matches,
      metadata: {
        ...result.metadata,
        requestedBackend: "kernel-dev",
        actualBackend: "rg_fallback",
        kernelFreshnessMode: this.freshnessMode,
        fallbackReason: reason,
        timings: {
          totalMs: performance.now() - started,
          fallbackMs: result.metadata.timings.totalMs,
        },
      },
    };
  }
}
