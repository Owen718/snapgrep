import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, type Dirent } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.js";

export type IndexMode = "git" | "workspace";
export type IndexLifecycle = "idle" | "building" | "starting" | "ready" | "error" | "stopped";

export interface IndexStatus {
  lifecycle: IndexLifecycle;
  mode: IndexMode;
  root: string;
  indexDir: string;
  baseUrl?: string;
  pid?: number;
  indexedCommit?: string;
  currentCommit?: string;
  buildDurationMs?: number;
  indexBytes?: number;
  overlayRevision?: number;
  overlayFiles?: number;
  overlayBuildDurationMs?: number;
  overlayReadyLatencyMs?: number;
  overlayUpdatedAt?: string;
  overlayError?: string;
  indexIgnoreRule?: string;
  vacuumRuns?: number;
  vacuumFilesRemoved?: number;
  vacuumBytesReclaimed?: number;
  vacuumUpdatedAt?: string;
  maintenanceWarning?: string;
  submodulesPresent?: boolean;
  error?: string;
}

export interface CurrentCommitSnapshot {
  generation: number;
  known: boolean;
  commit?: string;
}

export interface OverlayUpdateResult {
  revision: number;
  generation: number;
  files: number;
  buildDurationMs: number;
  readyLatencyMs: number;
}

interface PersistedIndexState {
  schemaVersion: 1;
  mode: IndexMode;
  root: string;
  indexedCommit?: string;
  builtAt: string;
  buildDurationMs: number;
  indexBytes: number;
  zoektCommit: string;
}

export interface IndexManagerOptions {
  root: string;
  indexDir?: string;
  zoektGitIndexPath?: string;
  zoektIndexPath?: string;
  zoektWebserverPath?: string;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
}

const ZOEKT_COMMIT = "3c8b39b1ef4f8194cb912d7e6581cff9db224aa7";
const DELTA_SHARD_COMPACTION_THRESHOLD = 8;
const STALE_TEMP_MIN_AGE_MS = 60 * 60 * 1_000;
const OWNED_OVERLAY_SHARD_PATTERN =
  /^fast-grep-overlay-[A-Za-z0-9_-]{1,64}_v\d+\.\d{5}\.zoekt(?:\.meta)?$/u;
const IGNORED_WORKSPACE_DIRS = [
  ".git",
  ".hg",
  ".svn",
  ".pi",
  ".fast-grep",
  ".deps",
  ".tools",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
];

export interface IndexVacuumResult {
  removedFiles: number;
  reclaimedBytes: number;
  completedAt: string;
}

export interface IndexVacuumOptions {
  nowMs?: number;
  staleTempMinAgeMs?: number;
}

export function overlayShardPrefix(root: string): string {
  return `fast-grep-overlay-${Buffer.from(path.resolve(root)).toString("base64url").slice(-24)}`;
}

/**
 * Remove only artifacts owned by the workspace-overlay lifecycle plus stale
 * crashed-writer temporaries. Base shards (including compound shards) are
 * deliberately never inferred from a broad `*.zoekt` glob.
 */
export async function vacuumOwnedIndexArtifacts(
  indexDir: string,
  options: IndexVacuumOptions = {},
): Promise<IndexVacuumResult> {
  const nowMs = options.nowMs ?? Date.now();
  const staleTempMinAgeMs = options.staleTempMinAgeMs ?? STALE_TEMP_MIN_AGE_MS;
  let removedFiles = 0;
  let reclaimedBytes = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(indexDir, { withFileTypes: true });
  } catch {
    return { removedFiles, reclaimedBytes, completedAt: new Date(nowMs).toISOString() };
  }

  for (const entry of entries) {
    const target = path.join(indexDir, entry.name);
    const ownedSessionArtifact =
      entry.name === "overlay-source"
      || entry.name === "overlay.meta.json"
      || OWNED_OVERLAY_SHARD_PATTERN.test(entry.name);
    let staleTemporary = false;
    if (entry.isFile() && entry.name.endsWith(".tmp")) {
      try {
        const info = await stat(target);
        staleTemporary = nowMs - info.mtimeMs >= staleTempMinAgeMs;
      } catch {
        // A concurrent cleanup already won the race.
      }
    }
    if (!ownedSessionArtifact && !staleTemporary) continue;

    const bytes = entry.isDirectory()
      ? await directoryBytes(target)
      : await stat(target).then((info) => info.size, () => 0);
    await rm(target, { recursive: entry.isDirectory(), force: true });
    removedFiles += 1;
    reclaimedBytes += bytes;
  }

  return {
    removedFiles,
    reclaimedBytes,
    completedAt: new Date(nowMs).toISOString(),
  };
}

function escapeGitIgnoreLiteral(value: string): string {
  return value.replace(/[\\[\]*?!# ]/gu, "\\$&");
}

/**
 * Add an anchored, repository-local ignore rule without modifying a tracked
 * .gitignore. Returns the installed/existing rule, or undefined outside Git or
 * when the index lives outside the repository.
 */
export async function installProjectIndexIgnore(
  root: string,
  indexDir: string,
): Promise<string | undefined> {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(indexDir));
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || relative.includes("\0")
    || relative.includes("\n")
    || relative.includes("\r")
  ) {
    return undefined;
  }

  const repository = await runCommand(
    "git",
    ["-C", resolvedRoot, "rev-parse", "--is-inside-work-tree"],
    { allowExitCodes: [0, 128] },
  );
  if (repository.code !== 0 || repository.stdout.trim() !== "true") return undefined;

  const gitPath = await runCommand(
    "git",
    ["-C", resolvedRoot, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
  );
  const excludePath = path.resolve(resolvedRoot, gitPath.stdout.trim());
  const relativePosix = relative.split(path.sep).join("/");
  const rule = `/${relativePosix.split("/").map(escapeGitIgnoreLiteral).join("/")}/`;
  await mkdir(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // appendFile creates a missing exclude file below.
  }
  if (existing.split(/\r?\n/u).includes(rule)) return rule;

  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? newline : "";
  await appendFile(excludePath, `${separator}${rule}${newline}`, { encoding: "utf8", mode: 0o600 });
  return rule;
}

function moduleProjectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(explicit: string | undefined, envName: string, name: string): Promise<string> {
  const candidates = [
    explicit,
    process.env[envName],
    path.join(moduleProjectRoot(), ".tools", name),
    path.join(process.cwd(), ".tools", name),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  return name;
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a loopback port")));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) total += await directoryBytes(target);
      else if (entry.isFile()) total += (await stat(target)).size;
    }
  } catch {
    return 0;
  }
  return total;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stoppedError(): Error {
  const error = new Error("Index manager stopped");
  error.name = "AbortError";
  return error;
}

export class IndexManager {
  readonly root: string;
  readonly indexDir: string;
  readonly statePath: string;
  readonly logPath: string;

  private readonly options: IndexManagerOptions;
  private readonly overlaySourceDir: string;
  private readonly overlayMetaPath: string;
  private readonly overlayPrefix: string;
  private lifecycle: IndexLifecycle = "idle";
  private mode: IndexMode = "workspace";
  private indexedCommit: string | undefined;
  private buildDurationMs: number | undefined;
  private indexBytes: number | undefined;
  private lastError: string | undefined;
  private baseUrl: string | undefined;
  private webserver: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private activeIndexOperation: AbortController | undefined;
  private readonly overlayPaths = new Set<string>();
  private overlayRevision = 0;
  private overlayFiles = 0;
  private overlayBuildDurationMs: number | undefined;
  private overlayReadyLatencyMs: number | undefined;
  private overlayUpdatedAt: string | undefined;
  private overlayError: string | undefined;
  private overlayToken: string | undefined;
  private repositoryPreparationPromise: Promise<void> | undefined;
  private indexIgnoreRule: string | undefined;
  private vacuumRuns = 0;
  private vacuumFilesRemoved = 0;
  private vacuumBytesReclaimed = 0;
  private vacuumUpdatedAt: string | undefined;
  private maintenanceWarning: string | undefined;
  private submodulesPresent = false;
  private stopped = false;
  private session = 0;
  private currentCommitGeneration = 0;
  private currentCommitKnown = false;
  private currentCommitValue: string | undefined;
  private currentCommitPromise: Promise<string | undefined> | undefined;

  constructor(options: IndexManagerOptions) {
    this.options = options;
    this.root = path.resolve(options.root);
    this.indexDir = path.resolve(options.indexDir ?? path.join(this.root, ".pi", "index", "fast-grep"));
    this.statePath = path.join(this.indexDir, "state.json");
    this.logPath = path.join(this.indexDir, "zoekt-webserver.log");
    this.overlaySourceDir = path.join(this.indexDir, "overlay-source");
    this.overlayMetaPath = path.join(this.indexDir, "overlay.meta.json");
    this.overlayPrefix = overlayShardPrefix(this.root);
  }

  get url(): string | undefined {
    return this.lifecycle === "ready" ? this.baseUrl : undefined;
  }

  get ready(): boolean {
    return this.lifecycle === "ready" && Boolean(this.baseUrl) && Boolean(this.webserver?.pid);
  }

  /** Paths represented by the current worktree overlay rather than the base commit shard. */
  workspaceOverlayPaths(): ReadonlySet<string> {
    return new Set(this.overlayPaths);
  }

  status(): IndexStatus {
    const status: IndexStatus = {
      lifecycle: this.lifecycle,
      mode: this.mode,
      root: this.root,
      indexDir: this.indexDir,
    };
    if (this.baseUrl !== undefined) status.baseUrl = this.baseUrl;
    if (this.webserver?.pid !== undefined) status.pid = this.webserver.pid;
    if (this.indexedCommit !== undefined) status.indexedCommit = this.indexedCommit;
    if (this.buildDurationMs !== undefined) status.buildDurationMs = this.buildDurationMs;
    if (this.indexBytes !== undefined) status.indexBytes = this.indexBytes;
    status.overlayRevision = this.overlayRevision;
    status.overlayFiles = this.overlayFiles;
    if (this.overlayBuildDurationMs !== undefined) status.overlayBuildDurationMs = this.overlayBuildDurationMs;
    if (this.overlayReadyLatencyMs !== undefined) status.overlayReadyLatencyMs = this.overlayReadyLatencyMs;
    if (this.overlayUpdatedAt !== undefined) status.overlayUpdatedAt = this.overlayUpdatedAt;
    if (this.overlayError !== undefined) status.overlayError = this.overlayError;
    if (this.indexIgnoreRule !== undefined) status.indexIgnoreRule = this.indexIgnoreRule;
    status.vacuumRuns = this.vacuumRuns;
    status.vacuumFilesRemoved = this.vacuumFilesRemoved;
    status.vacuumBytesReclaimed = this.vacuumBytesReclaimed;
    if (this.vacuumUpdatedAt !== undefined) status.vacuumUpdatedAt = this.vacuumUpdatedAt;
    if (this.maintenanceWarning !== undefined) status.maintenanceWarning = this.maintenanceWarning;
    status.submodulesPresent = this.submodulesPresent;
    if (this.lastError !== undefined) status.error = this.lastError;
    return status;
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.stopped) {
      // A call racing an in-progress stop belongs to the session being torn
      // down and must not enqueue work behind stop's quiescence barrier. Once
      // stop has completed, an explicit start may begin a fresh session.
      if (this.stopPromise || this.lifecycle !== "stopped") {
        return Promise.reject(stoppedError());
      }
      this.stopped = false;
      this.session += 1;
    }
    if (this.refreshPromise) return this.refreshPromise;
    const session = this.session;
    this.startPromise = this.withIndexMutation(async () => {
      if (!this.isSessionActive(session)) return;
      await this.initialize(session);
    }).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /**
   * Prepare repository-local bookkeeping before DirtyTracker takes its first
   * status snapshot. Failure is observable but non-fatal: search correctness
   * must not depend on being able to edit Git's local exclude file.
   */
  async prepareRepositoryRuntime(): Promise<void> {
    if (this.repositoryPreparationPromise === undefined) {
      this.repositoryPreparationPromise = installProjectIndexIgnore(this.root, this.indexDir)
        .then((rule) => {
          this.indexIgnoreRule = rule;
          this.maintenanceWarning = undefined;
        })
        .catch((error) => {
          this.maintenanceWarning = `could not install project-local index ignore: ${errorMessage(error)}`;
        });
    }
    await this.repositoryPreparationPromise;
  }

  startInBackground(): void {
    void this.start().catch(() => undefined);
  }

  async currentCommit(): Promise<string | undefined> {
    if (this.currentCommitKnown) return this.currentCommitValue;
    if (this.currentCommitPromise !== undefined) return this.currentCommitPromise;

    const generation = this.currentCommitGeneration;
    const pending = (async () => {
      try {
        const result = await runCommand("git", ["-C", this.root, "rev-parse", "HEAD"]);
        const commit = result.stdout.trim() || undefined;
        if (generation === this.currentCommitGeneration) {
          this.currentCommitValue = commit;
          this.currentCommitKnown = true;
        }
        return commit;
      } catch {
        return undefined;
      }
    })().finally(() => {
      if (this.currentCommitPromise === pending) this.currentCommitPromise = undefined;
    });
    this.currentCommitPromise = pending;
    return pending;
  }

  currentCommitSnapshot(): CurrentCommitSnapshot {
    return {
      generation: this.currentCommitGeneration,
      known: this.currentCommitKnown,
      ...(this.currentCommitValue === undefined ? {} : { commit: this.currentCommitValue }),
    };
  }

  invalidateCurrentCommit(): void {
    this.currentCommitGeneration += 1;
    this.currentCommitKnown = false;
    this.currentCommitValue = undefined;
  }

  async isCurrent(): Promise<boolean> {
    if (this.mode !== "git") return this.ready;
    const current = await this.currentCommit();
    return this.ready && current !== undefined && current === this.indexedCommit;
  }

  async refreshIfNeeded(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.stopped) return;
    const session = this.session;
    this.refreshPromise = this.withIndexMutation(async () => {
      if (!this.isSessionActive(session)) return;
      if (this.mode !== "git") return;
      const current = await this.currentCommit();
      if (!this.isSessionActive(session)) return;
      if (current === undefined || current === this.indexedCommit) return;
      await this.performBuildIndex(current, session);
      if (this.isSessionActive(session) && !this.ready) {
        await this.startWebserver(session);
      }
    }).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  refreshInBackground(): void {
    void this.refreshIfNeeded().catch((error) => {
      this.lastError = errorMessage(error);
    });
  }

  async updateWorkspaceOverlay(
    changedPaths: ReadonlySet<string>,
    generation: number,
  ): Promise<OverlayUpdateResult> {
    const session = this.session;
    return this.withIndexMutation(async () => {
      if (!this.isSessionActive(session)) throw stoppedError();
      for (const relativePath of changedPaths) {
        const normalized = relativePath.split(path.sep).join("/").replace(/^\.\//u, "");
        const absolutePath = path.resolve(this.root, normalized);
        const relative = path.relative(this.root, absolutePath);
        if (
          normalized.length > 0
          && relative !== ""
          && relative !== ".."
          && !relative.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relative)
        ) {
          this.overlayPaths.add(normalized);
        }
      }

      const startedAt = performance.now();
      try {
        const result = await this.buildWorkspaceOverlay(generation, startedAt, session);
        this.overlayError = undefined;
        return result;
      } catch (error) {
        this.overlayError = errorMessage(error);
        throw error;
      }
    });
  }

  async restartWebserver(): Promise<void> {
    const session = this.session;
    await this.withIndexMutation(async () => {
      if (!this.isSessionActive(session)) return;
      await this.stopWebserver();
      if (!this.isSessionActive(session)) return;
      await this.startWebserver(session);
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.session += 1;
    this.invalidateCurrentCommit();
    this.activeIndexOperation?.abort(stoppedError());
    const stopPromise = this.withIndexMutation(async () => {
      await this.stopWebserver();
      this.lifecycle = "stopped";
    });
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = undefined;
    }
  }

  private async initialize(session: number): Promise<void> {
    try {
      if (!this.isSessionActive(session)) return;
      await this.prepareRepositoryRuntime();
      if (!this.isSessionActive(session)) return;
      await mkdir(this.indexDir, { recursive: true });
      if (!this.isSessionActive(session)) return;
      await this.loadState();
      const commit = await this.currentCommit();
      if (!this.isSessionActive(session)) return;
      this.mode = commit === undefined ? "workspace" : "git";
      this.submodulesPresent = commit === undefined ? false : await this.detectSubmodules();
      if (!this.isSessionActive(session)) return;
      // Overlay shards are session-scoped. DirtyTracker reconstructs the
      // current worktree delta and republishes it after the sidecar starts.
      await this.clearOverlayArtifacts(false);
      if (!this.isSessionActive(session)) return;
      const hasShards = await this.hasIndexShards();
      if (!hasShards || (this.mode === "git" && commit !== this.indexedCommit)) {
        await this.performBuildIndex(commit, session);
      }
      if (!this.isSessionActive(session)) return;
      await this.startWebserver(session);
    } catch (error) {
      if (!this.isSessionActive(session)) return;
      this.lifecycle = "error";
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  private async hasIndexShards(): Promise<boolean> {
    try {
      const entries = await readdir(this.indexDir);
      return entries.some((entry) => entry.endsWith(".zoekt"));
    } catch {
      return false;
    }
  }

  private async detectSubmodules(): Promise<boolean> {
    try {
      const result = await runCommand(
        "git",
        ["-C", this.root, "submodule", "status", "--recursive"],
        { allowExitCodes: [0] },
      );
      return result.stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  private async loadState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PersistedIndexState;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.root !== this.root ||
        parsed.zoektCommit !== ZOEKT_COMMIT
      ) return;
      this.mode = parsed.mode;
      this.indexedCommit = parsed.indexedCommit;
      this.buildDurationMs = parsed.buildDurationMs;
      this.indexBytes = parsed.indexBytes;
    } catch {
      // A missing or partial state file is repaired by the next successful build.
    }
  }

  private async performBuildIndex(commit: string | undefined, session: number): Promise<void> {
    if (!this.isSessionActive(session)) throw stoppedError();
    this.lifecycle = "building";
    this.lastError = undefined;
    const operation = new AbortController();
    this.activeIndexOperation = operation;
    try {
      await mkdir(this.indexDir, { recursive: true });
      if (!this.isSessionActive(session)) throw stoppedError();
      this.overlayPaths.clear();
      await this.clearOverlayArtifacts(false);
      if (!this.isSessionActive(session)) throw stoppedError();
      const started = performance.now();

      if (commit !== undefined) {
        this.mode = "git";
        const binary = await findBinary(
          this.options.zoektGitIndexPath,
          "PI_FAST_GREP_ZOEKT_GIT_INDEX",
          "zoekt-git-index",
        );
        const args = [
          "-index",
          this.indexDir,
          "-disable_ctags",
          "-submodules=false",
          "-branches",
          "HEAD",
          "-incremental=true",
        ];
        if (process.env.PI_FAST_GREP_ZOEKT_DELTA === "1" && (await this.hasIndexShards())) {
          // A normal build atomically replaces its old simple shards. Optional
          // delta builds are bounded by forcing that same compaction once the
          // repository exceeds the threshold; compound merging is intentionally
          // avoided for this dedicated single-repository index.
          args.push(
            "-delta=true",
            `-delta_threshold=${DELTA_SHARD_COMPACTION_THRESHOLD}`,
          );
        }
        args.push(this.root);
        await runCommand(binary, args, { cwd: this.root, signal: operation.signal });
        this.indexedCommit = commit;
      } else {
        this.mode = "workspace";
        const binary = await findBinary(
          this.options.zoektIndexPath,
          "PI_FAST_GREP_ZOEKT_INDEX",
          "zoekt-index",
        );
        const metaPath = path.join(this.indexDir, "workspace.meta.json");
        await writeFile(
          metaPath,
          `${JSON.stringify({ Name: `workspace/${Buffer.from(this.root).toString("base64url")}`, Source: this.root })}\n`,
          { mode: 0o600 },
        );
        if (!this.isSessionActive(session)) throw stoppedError();
        await runCommand(
          binary,
          [
            "-index",
            this.indexDir,
            "-disable_ctags",
            "-parallelism",
            String(Math.max(1, Math.min(4, cpus().length))),
            "-ignore_dirs",
            IGNORED_WORKSPACE_DIRS.join(","),
            "-meta",
            metaPath,
            this.root,
          ],
          { cwd: this.root, signal: operation.signal },
        );
        this.indexedCommit = undefined;
      }

      if (!this.isSessionActive(session)) throw stoppedError();
      this.buildDurationMs = performance.now() - started;
      this.indexBytes = await directoryBytes(this.indexDir);
      if (!this.isSessionActive(session)) throw stoppedError();
      const state: PersistedIndexState = {
        schemaVersion: 1,
        mode: this.mode,
        root: this.root,
        builtAt: new Date().toISOString(),
        buildDurationMs: this.buildDurationMs,
        indexBytes: this.indexBytes,
        zoektCommit: ZOEKT_COMMIT,
      };
      if (this.indexedCommit !== undefined) state.indexedCommit = this.indexedCommit;
      await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
      if (!this.isSessionActive(session)) throw stoppedError();
      this.lifecycle = "idle";
    } finally {
      if (this.activeIndexOperation === operation) this.activeIndexOperation = undefined;
    }
  }

  private async buildWorkspaceOverlay(
    generation: number,
    startedAt: number,
    session: number,
  ): Promise<OverlayUpdateResult> {
    if (!this.isSessionActive(session)) throw stoppedError();
    const operation = new AbortController();
    this.activeIndexOperation = operation;
    try {
      await mkdir(this.indexDir, { recursive: true });
      if (!this.isSessionActive(session)) throw stoppedError();
      await rm(this.overlaySourceDir, { recursive: true, force: true });
      await mkdir(this.overlaySourceDir, { recursive: true });

      let files = 0;
      for (const relativePath of [...this.overlayPaths].sort()) {
        if (!this.isSessionActive(session) || operation.signal.aborted) throw stoppedError();
        const source = path.resolve(this.root, relativePath);
        const relative = path.relative(this.root, source);
        if (
          relative === ""
          || relative === ".."
          || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative)
        ) continue;
        try {
          const info = await lstat(source);
          if (!info.isFile()) continue;
          const destination = path.join(this.overlaySourceDir, relativePath);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(source, destination);
          files += 1;
        } catch (error) {
          if (!this.isSessionActive(session) || operation.signal.aborted) throw error;
          // Deleted files intentionally have no overlay document. The stale base
          // path is still rejected by exact candidate verification.
        }
      }

      const token = `FAST_GREP_OVERLAY_READY_${process.pid}_${generation}_${Date.now()}`;
      const sentinelPath = ".fast-grep-overlay-ready";
      await writeFile(path.join(this.overlaySourceDir, sentinelPath), `${token}\n`, { mode: 0o600 });
      await writeFile(
        this.overlayMetaPath,
        `${JSON.stringify({
          Name: `fast-grep-overlay/${Buffer.from(this.root).toString("base64url")}`,
          Source: this.overlaySourceDir,
        })}\n`,
        { mode: 0o600 },
      );
      if (!this.isSessionActive(session)) throw stoppedError();

      const binary = await findBinary(
        this.options.zoektIndexPath,
        "PI_FAST_GREP_ZOEKT_INDEX",
        "zoekt-index",
      );
      await runCommand(
        binary,
        [
          "-index",
          this.indexDir,
          "-disable_ctags",
          "-parallelism",
          String(Math.max(1, Math.min(4, cpus().length))),
          "-ignore_dirs",
          ".git,.hg,.svn,node_modules",
          "-shard_prefix_override",
          this.overlayPrefix,
          "-meta",
          this.overlayMetaPath,
          this.overlaySourceDir,
        ],
        { cwd: this.root, signal: operation.signal },
      );
      if (!this.isSessionActive(session)) throw stoppedError();
      const buildDurationMs = performance.now() - startedAt;
      const readyStartedAt = performance.now();
      await this.waitForOverlayToken(token, sentinelPath, operation.signal);
      if (!this.isSessionActive(session)) throw stoppedError();
      const readyLatencyMs = performance.now() - readyStartedAt;

      this.overlayRevision += 1;
      this.overlayFiles = files;
      this.overlayBuildDurationMs = buildDurationMs;
      this.overlayReadyLatencyMs = readyLatencyMs;
      this.overlayUpdatedAt = new Date().toISOString();
      this.overlayToken = token;
      this.indexBytes = await directoryBytes(this.indexDir);
      return {
        revision: this.overlayRevision,
        generation,
        files,
        buildDurationMs,
        readyLatencyMs,
      };
    } finally {
      if (this.activeIndexOperation === operation) this.activeIndexOperation = undefined;
    }
  }

  private async waitForOverlayToken(
    token: string,
    sentinelPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.baseUrl || !this.ready) {
      throw new Error("Zoekt webserver is not ready to acknowledge the workspace overlay");
    }
    const deadline = performance.now() + 2_000;
    let lastError = "overlay shard not visible";
    while (performance.now() < deadline) {
      if (signal.aborted) throw signal.reason;
      try {
        const response = await fetch(`${this.baseUrl}/api/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            Q: `type:file case:yes content:\"${token}\"`,
            Opts: { MaxDocDisplayCount: 4, NumContextLines: 0 },
          }),
          signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            Result?: { Files?: Array<{ FileName?: string }> | null };
          };
          if ((payload.Result?.Files ?? []).some((file) => file.FileName === sentinelPath)) return;
          lastError = "overlay sentinel was absent from the search response";
        } else {
          lastError = `overlay readiness HTTP ${response.status}`;
        }
      } catch (error) {
        lastError = errorMessage(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Zoekt overlay reload timed out: ${lastError}`);
  }

  private async clearOverlayArtifacts(waitForReload: boolean): Promise<void> {
    const oldToken = this.overlayToken;
    const vacuum = await vacuumOwnedIndexArtifacts(this.indexDir);
    this.vacuumRuns += 1;
    this.vacuumFilesRemoved += vacuum.removedFiles;
    this.vacuumBytesReclaimed += vacuum.reclaimedBytes;
    this.vacuumUpdatedAt = vacuum.completedAt;
    this.indexBytes = await directoryBytes(this.indexDir);
    this.overlayFiles = 0;
    this.overlayToken = undefined;
    if (waitForReload && oldToken && this.baseUrl && this.ready) {
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        try {
          const response = await fetch(`${this.baseUrl}/api/search`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              Q: `type:file case:yes content:\"${oldToken}\"`,
              Opts: { MaxDocDisplayCount: 1, NumContextLines: 0 },
            }),
          });
          const payload = (await response.json()) as { Result?: { Files?: unknown[] | null } };
          if ((payload.Result?.Files ?? []).length === 0) break;
        } catch {
          // Keep polling until the bounded deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async withIndexMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private isSessionActive(session: number): boolean {
    return !this.stopped && this.session === session;
  }

  private async startWebserver(session: number): Promise<void> {
    if (!this.isSessionActive(session)) return;
    if (
      this.webserver
      && this.webserver.exitCode === null
      && this.webserver.signalCode === null
      && this.baseUrl
    ) {
      this.lifecycle = "ready";
      return;
    }
    this.lifecycle = "starting";
    const binary = await findBinary(
      this.options.zoektWebserverPath,
      "PI_FAST_GREP_ZOEKT_WEBSERVER",
      "zoekt-webserver",
    );
    if (!this.isSessionActive(session)) return;
    const port = await findFreePort();
    if (!this.isSessionActive(session)) return;
    const baseUrl = `http://127.0.0.1:${port}`;
    const logHandle = await open(this.logPath, "a", 0o600);
    if (!this.isSessionActive(session)) {
      await logHandle.close();
      return;
    }
    const child = spawn(
      binary,
      ["-listen", `127.0.0.1:${port}`, "-index", this.indexDir, "-rpc", "-html=false"],
      {
        cwd: this.root,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
        detached: false,
      },
    );
    this.webserver = child;
    this.baseUrl = baseUrl;
    child.once("exit", (code, signal) => {
      void logHandle.close().catch(() => undefined);
      if (this.webserver !== child) return;
      this.webserver = undefined;
      this.baseUrl = undefined;
      if (!this.stopped) {
        this.lifecycle = "error";
        this.lastError = `zoekt-webserver exited (${code ?? signal ?? "unknown"})`;
      }
    });
    child.once("error", (error) => {
      this.lastError = error.message;
    });

    const startupTimeout = this.options.startupTimeoutMs ?? 15_000;
    const deadline = performance.now() + startupTimeout;
    let lastHealthError = "not ready";
    while (this.isSessionActive(session) && performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      let timer: NodeJS.Timeout | undefined;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), this.options.healthTimeoutMs ?? 1_000);
        const response = await fetch(`${baseUrl}/healthz`, { signal: controller.signal });
        if (this.isSessionActive(session) && response.ok) {
          const health = (await response.json()) as { Crashes?: number };
          if (this.isSessionActive(session) && (health.Crashes ?? 0) === 0) {
            this.lifecycle = "ready";
            this.lastError = undefined;
            return;
          }
          lastHealthError = `health Crashes=${health.Crashes}`;
        } else {
          lastHealthError = `health HTTP ${response.status}`;
        }
      } catch (error) {
        lastHealthError = errorMessage(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!this.isSessionActive(session)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.stopWebserver();
    if (!this.isSessionActive(session)) return;
    throw new Error(`zoekt-webserver failed readiness: ${lastHealthError}`);
  }

  private async stopWebserver(): Promise<void> {
    const child = this.webserver;
    this.webserver = undefined;
    this.baseUrl = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await waitForChildExit(child, "SIGTERM", 2_000);
    if (child.exitCode === null && child.signalCode === null) {
      await waitForChildExit(child, "SIGKILL");
    }
  }
}

async function waitForChildExit(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs?: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    if (timeoutMs !== undefined) {
      timer = setTimeout(finish, timeoutMs);
      timer.unref();
    }
    if (
      !child.kill(signal)
      && (child.exitCode !== null || child.signalCode !== null)
    ) finish();
  });
}
