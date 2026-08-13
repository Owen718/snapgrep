import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { runCommand } from "./process.js";
import type { DirtySnapshot } from "./types.js";

const INTERNAL_PREFIXES = [".git/", ".pi/index/", ".fast-grep/"];

export type DirtyWatcherFactory = (
  root: string,
  listener: (eventType: string, filename: string | null) => void,
) => FSWatcher;

export type DirtyListener = (generation: number, headMayHaveChanged: boolean) => void;

const defaultWatcherFactory: DirtyWatcherFactory = (root, listener) =>
  watch(root, { recursive: true, persistent: false, encoding: "utf8" }, listener);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function ignored(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\.\//, "");
  return (
    normalized === ".git" ||
    normalized === ".pi" ||
    normalized === ".pi/index" ||
    normalized === ".fast-grep" ||
    INTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function mayChangeHead(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized === ".git/HEAD"
    || normalized === ".git/packed-refs"
    || normalized.startsWith(".git/refs/");
}

function resolveToolPath(value: string, cwd: string): string {
  let normalized = value;
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = path.join(homedir(), normalized.slice(2));
  return path.resolve(cwd, normalized);
}

export interface DirtyTrackerOptions {
  runCommand?: typeof runCommand;
  watchFactory?: DirtyWatcherFactory;
  /**
   * A trusted, point-in-time replacement for the first git status scan.
   *
   * `undefined` preserves the default full scan. An explicitly supplied array,
   * including an empty one, is consumed once; a restarted tracker falls back to
   * git because the original snapshot is no longer current.
   */
  initialDirtyPaths?: readonly string[];
}

export function normalizeInitialDirtyPaths(
  root: string,
  initialDirtyPaths: readonly string[],
): string[] {
  const resolvedRoot = path.resolve(root);
  const normalized = new Set<string>();
  for (const value of initialDirtyPaths) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new Error("initial dirty paths must be non-empty strings without NUL bytes");
    }
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
      throw new Error(`initial dirty path must be repository-relative: ${value}`);
    }
    const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, value));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`initial dirty path is outside the repository: ${value}`);
    }
    const posix = toPosix(path.normalize(relative)).replace(/^\.\//, "");
    if (!ignored(posix)) normalized.add(posix);
  }
  return [...normalized];
}

export class DirtyCoverageError extends Error {
  constructor() {
    super(
      "workspace dirty coverage is untrusted after git status failed or filesystem watching became unavailable",
    );
    this.name = "DirtyCoverageError";
  }
}

export class DirtyTracker {
  readonly root: string;

  private readonly dirty = new Set<string>();
  private readonly pathGenerations = new Map<string, number>();
  private readonly listeners = new Set<DirtyListener>();
  private readonly commandRunner: typeof runCommand;
  private readonly watcherFactory: DirtyWatcherFactory;
  private readonly initialDirtyPaths: readonly string[] | undefined;
  private watcher: FSWatcher | undefined;
  private watcherHealthy = false;
  private trackingStarted = false;
  private coverageTrusted = false;
  private initialDirtyPathsConsumed = false;
  private generation = 0;
  private needsGitRefresh = false;
  private gitRepository = false;
  private refreshPromise: Promise<void> | undefined;
  private replaceAfterRefresh = false;

  constructor(root: string, options: DirtyTrackerOptions = {}) {
    this.root = path.resolve(root);
    this.commandRunner = options.runCommand ?? runCommand;
    this.watcherFactory = options.watchFactory ?? defaultWatcherFactory;
    this.initialDirtyPaths =
      options.initialDirtyPaths === undefined
        ? undefined
        : normalizeInitialDirtyPaths(this.root, options.initialDirtyPaths);
  }

  async start(): Promise<void> {
    this.trackingStarted = true;
    // Watch first so a path changed while the initial snapshot is installed or
    // git status is in flight receives a later generation and is preserved.
    this.installWatcher();
    if (this.initialDirtyPaths !== undefined && !this.initialDirtyPathsConsumed) {
      this.initialDirtyPathsConsumed = true;
      this.seedInitialDirtyPaths(this.initialDirtyPaths);
      this.coverageTrusted = this.watcherHealthy && !this.needsGitRefresh;
    } else {
      await this.refreshFromGit(true);
    }
  }

  private installWatcher(): void {
    try {
      const watcher = this.watcherFactory(this.root, (_event, filename) => {
        if (!filename) {
          this.markWorkspaceUnknown();
          return;
        }
        if (mayChangeHead(filename)) {
          this.markWorkspaceUnknown();
          return;
        }
        this.markRelative(filename);
      });
      this.watcher = watcher;
      watcher.on("error", () => {
        if (this.watcher !== watcher) return;
        this.watcherHealthy = false;
        this.markWorkspaceUnknown();
      });
      watcher.on("close", () => {
        if (this.watcher !== watcher) return;
        this.watcherHealthy = false;
        if (this.trackingStarted) this.markWorkspaceUnknown();
      });
      this.watcherHealthy = true;
    } catch {
      // Tool hooks and the conservative git refresh path remain active.
      this.watcher = undefined;
      this.watcherHealthy = false;
      this.markWorkspaceUnknown();
    }
  }

  private seedInitialDirtyPaths(initialDirtyPaths: readonly string[]): void {
    if (initialDirtyPaths.length === 0) return;
    const seedGeneration = this.nextGeneration();
    for (const relativePath of initialDirtyPaths) {
      this.dirty.add(relativePath);
      this.pathGenerations.set(relativePath, seedGeneration);
    }
    this.notify(seedGeneration, false);
  }

  stop(): void {
    this.trackingStarted = false;
    const watcher = this.watcher;
    this.watcher = undefined;
    this.watcherHealthy = false;
    this.coverageTrusted = false;
    watcher?.close();
  }

  onDirty(listener: DirtyListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markToolPath(value: unknown, cwd = this.root): void {
    if (typeof value !== "string" || value.length === 0) {
      this.markWorkspaceUnknown();
      return;
    }
    this.markAbsolute(resolveToolPath(value, cwd));
  }

  markAbsolute(absolutePath: string): void {
    const relative = path.relative(this.root, path.resolve(absolutePath));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) return;
    this.markRelative(relative);
  }

  markRelative(relativePath: string): void {
    const normalized = toPosix(path.normalize(relativePath)).replace(/^\.\//, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || ignored(normalized)) return;
    const eventGeneration = this.nextGeneration();
    this.dirty.add(normalized);
    this.pathGenerations.set(normalized, eventGeneration);
    this.notify(eventGeneration, false);
  }

  markWorkspaceUnknown(): void {
    const generation = this.nextGeneration();
    this.coverageTrusted = false;
    this.needsGitRefresh = true;
    this.notify(generation, true);
  }

  /**
   * Removes only paths whose most recent event was visible in the supplied
   * snapshot. Work is bounded by `paths`; it never scans the whole workspace or
   * invokes git. A later event for the same path therefore survives an
   * acknowledgement of an older snapshot.
   */
  acknowledgeIndexedPaths(paths: ReadonlySet<string>, snapshotGeneration: number): number {
    if (!Number.isSafeInteger(snapshotGeneration) || snapshotGeneration < 0) return 0;

    const removable: string[] = [];
    for (const relativePath of paths) {
      const lastEventGeneration = this.pathGenerations.get(relativePath);
      if (lastEventGeneration !== undefined && lastEventGeneration <= snapshotGeneration) {
        removable.push(relativePath);
      }
    }
    if (removable.length === 0) return 0;

    for (const relativePath of removable) {
      this.dirty.delete(relativePath);
      this.pathGenerations.delete(relativePath);
    }
    this.nextGeneration();
    return removable.length;
  }

  async refreshIfNeeded(): Promise<void> {
    if (!this.needsGitRefresh) return;
    await this.refreshFromGit(false);
  }

  async refreshFromGit(replace: boolean): Promise<void> {
    if (this.refreshPromise) {
      if (replace) this.replaceAfterRefresh = true;
      await this.refreshPromise;
      if (this.replaceAfterRefresh) {
        this.replaceAfterRefresh = false;
        await this.refreshFromGit(true);
      }
      return;
    }
    this.refreshPromise = this.runGitRefresh(replace).finally(() => {
      this.refreshPromise = undefined;
    });
    await this.refreshPromise;
    if (this.replaceAfterRefresh) {
      this.replaceAfterRefresh = false;
      await this.refreshFromGit(true);
    }
  }

  async acknowledgeIndexedCommit(
    commit: string | undefined,
    observedCurrentCommit?: string,
  ): Promise<void> {
    if (!commit || !this.gitRepository) return;
    let current = observedCurrentCommit;
    if (current === undefined) {
      try {
        current = (await this.commandRunner("git", ["-C", this.root, "rev-parse", "HEAD"])).stdout.trim();
      } catch {
        return;
      }
    }
    if (current !== commit) return;
    await this.refreshFromGit(true);
  }

  async snapshot(): Promise<DirtySnapshot> {
    if (this.trackingStarted && !this.watcherHealthy) this.needsGitRefresh = true;
    await this.refreshIfNeeded();
    if (this.trackingStarted && !this.coverageTrusted) {
      throw new DirtyCoverageError();
    }
    // Capture the generation atomically with the path set. Filesystem access
    // below yields; returning a later generation with this older path set would
    // let an acknowledgement incorrectly consume an event that arrived during
    // tombstone detection.
    const generation = this.generation;
    const paths = new Set(this.dirty);
    const tombstones = new Set<string>();
    await mapLimited(
      [...paths],
      64,
      async (relativePath) => {
        try {
          await access(path.join(this.root, relativePath));
        } catch {
          tombstones.add(relativePath);
        }
      },
    );
    return { paths, tombstones, generation };
  }

  private async runGitRefresh(replace: boolean): Promise<void> {
    const refreshStartedAt = this.generation;
    this.coverageTrusted = false;
    this.needsGitRefresh = false;
    let output: string;
    try {
      const result = await this.commandRunner(
        "git",
        ["-C", this.root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { allowExitCodes: [0] },
      );
      output = result.stdout;
      this.gitRepository = true;
    } catch {
      this.gitRepository = false;
      this.needsGitRefresh = true;
      return;
    }

    const next = new Set<string>();
    const records = output.split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      const status = record.slice(0, 2);
      const relativePath = record.slice(3);
      const normalized = toPosix(relativePath);
      if (!ignored(normalized)) next.add(normalized);
      if (status.includes("R") || status.includes("C")) {
        const original = records[index + 1];
        if (original) {
          const originalNormalized = toPosix(original);
          if (!ignored(originalNormalized)) next.add(originalNormalized);
          index += 1;
        }
      }
    }

    const desired = replace ? new Set(next) : new Set(this.dirty);
    if (!replace) {
      for (const relativePath of next) desired.add(relativePath);
    } else {
      // git status describes a scan that started at refreshStartedAt. Preserve
      // any watcher/tool event that arrived while that scan was in flight,
      // including another event for a path that was already dirty.
      for (const relativePath of this.dirty) {
        if ((this.pathGenerations.get(relativePath) ?? 0) > refreshStartedAt) {
          desired.add(relativePath);
        }
      }
    }

    const removed = [...this.dirty].filter((relativePath) => !desired.has(relativePath));
    const added = [...desired].filter((relativePath) => !this.dirty.has(relativePath));
    this.coverageTrusted =
      !this.trackingStarted || (this.watcherHealthy && !this.needsGitRefresh);
    if (removed.length === 0 && added.length === 0) return;

    for (const relativePath of removed) {
      this.dirty.delete(relativePath);
      this.pathGenerations.delete(relativePath);
    }
    const refreshGeneration = this.nextGeneration();
    for (const relativePath of added) {
      this.dirty.add(relativePath);
      this.pathGenerations.set(relativePath, refreshGeneration);
    }
    this.notify(refreshGeneration, false);
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private notify(generation: number, headMayHaveChanged: boolean): void {
    for (const listener of this.listeners) listener(generation, headMayHaveChanged);
  }
}

async function mapLimited<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        await visit(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
}
