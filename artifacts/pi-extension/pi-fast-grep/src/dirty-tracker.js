import { watch } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { runCommand } from "./process.js";
const INTERNAL_PREFIXES = [".git/", ".pi/index/", ".fast-grep/"];
const defaultWatcherFactory = (root, listener) => watch(root, { recursive: true, persistent: false, encoding: "utf8" }, listener);
function toPosix(value) {
    return value.split(path.sep).join("/");
}
function ignored(relativePath) {
    const normalized = relativePath.replace(/^\.\//, "");
    return (normalized === ".git" ||
        normalized === ".pi" ||
        normalized === ".pi/index" ||
        normalized === ".fast-grep" ||
        INTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix)));
}
function mayChangeHead(relativePath) {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
    return normalized === ".git/HEAD"
        || normalized === ".git/packed-refs"
        || normalized.startsWith(".git/refs/");
}
function resolveToolPath(value, cwd) {
    let normalized = value;
    if (normalized === "~")
        normalized = homedir();
    else if (normalized.startsWith("~/"))
        normalized = path.join(homedir(), normalized.slice(2));
    return path.resolve(cwd, normalized);
}
export function normalizeInitialDirtyPaths(root, initialDirtyPaths) {
    const resolvedRoot = path.resolve(root);
    const normalized = new Set();
    for (const value of initialDirtyPaths) {
        if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
            throw new Error("initial dirty paths must be non-empty strings without NUL bytes");
        }
        if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
            throw new Error(`initial dirty path must be repository-relative: ${value}`);
        }
        const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, value));
        if (!relative ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)) {
            throw new Error(`initial dirty path is outside the repository: ${value}`);
        }
        const posix = toPosix(path.normalize(relative)).replace(/^\.\//, "");
        if (!ignored(posix))
            normalized.add(posix);
    }
    return [...normalized];
}
export class DirtyCoverageError extends Error {
    constructor() {
        super("workspace dirty coverage is untrusted after git status failed or filesystem watching became unavailable");
        this.name = "DirtyCoverageError";
    }
}
export class DirtyTracker {
    root;
    dirty = new Set();
    pathGenerations = new Map();
    listeners = new Set();
    commandRunner;
    watcherFactory;
    initialDirtyPaths;
    watcher;
    watcherHealthy = false;
    trackingStarted = false;
    coverageTrusted = false;
    initialDirtyPathsConsumed = false;
    generation = 0;
    needsGitRefresh = false;
    gitRepository = false;
    refreshPromise;
    replaceAfterRefresh = false;
    constructor(root, options = {}) {
        this.root = path.resolve(root);
        this.commandRunner = options.runCommand ?? runCommand;
        this.watcherFactory = options.watchFactory ?? defaultWatcherFactory;
        this.initialDirtyPaths =
            options.initialDirtyPaths === undefined
                ? undefined
                : normalizeInitialDirtyPaths(this.root, options.initialDirtyPaths);
    }
    async start() {
        this.trackingStarted = true;
        // Watch first so a path changed while the initial snapshot is installed or
        // git status is in flight receives a later generation and is preserved.
        this.installWatcher();
        if (this.initialDirtyPaths !== undefined && !this.initialDirtyPathsConsumed) {
            this.initialDirtyPathsConsumed = true;
            this.seedInitialDirtyPaths(this.initialDirtyPaths);
            this.coverageTrusted = this.watcherHealthy && !this.needsGitRefresh;
        }
        else {
            await this.refreshFromGit(true);
        }
    }
    installWatcher() {
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
                if (this.watcher !== watcher)
                    return;
                this.watcherHealthy = false;
                this.markWorkspaceUnknown();
                // Coverage is already incomplete and a live watcher keeps holding
                // inotify descriptors, so release it and stay on the conservative path.
                this.watcher = undefined;
                watcher.close();
            });
            watcher.on("close", () => {
                if (this.watcher !== watcher)
                    return;
                this.watcherHealthy = false;
                if (this.trackingStarted)
                    this.markWorkspaceUnknown();
            });
            this.watcherHealthy = true;
        }
        catch {
            // Tool hooks and the conservative git refresh path remain active.
            this.watcher = undefined;
            this.watcherHealthy = false;
            this.markWorkspaceUnknown();
        }
    }
    seedInitialDirtyPaths(initialDirtyPaths) {
        if (initialDirtyPaths.length === 0)
            return;
        const seedGeneration = this.nextGeneration();
        for (const relativePath of initialDirtyPaths) {
            this.dirty.add(relativePath);
            this.pathGenerations.set(relativePath, seedGeneration);
        }
        this.notify(seedGeneration, false);
    }
    stop() {
        this.trackingStarted = false;
        const watcher = this.watcher;
        this.watcher = undefined;
        this.watcherHealthy = false;
        this.coverageTrusted = false;
        watcher?.close();
    }
    onDirty(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    markToolPath(value, cwd = this.root) {
        if (typeof value !== "string" || value.length === 0) {
            this.markWorkspaceUnknown();
            return;
        }
        this.markAbsolute(resolveToolPath(value, cwd));
    }
    markAbsolute(absolutePath) {
        const relative = path.relative(this.root, path.resolve(absolutePath));
        if (!relative ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative))
            return;
        this.markRelative(relative);
    }
    markRelative(relativePath) {
        const normalized = toPosix(path.normalize(relativePath)).replace(/^\.\//, "");
        if (!normalized || normalized === "." || normalized.startsWith("../") || ignored(normalized))
            return;
        const eventGeneration = this.nextGeneration();
        this.dirty.add(normalized);
        this.pathGenerations.set(normalized, eventGeneration);
        this.notify(eventGeneration, false);
    }
    markWorkspaceUnknown() {
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
    acknowledgeIndexedPaths(paths, snapshotGeneration) {
        if (!Number.isSafeInteger(snapshotGeneration) || snapshotGeneration < 0)
            return 0;
        const removable = [];
        for (const relativePath of paths) {
            const lastEventGeneration = this.pathGenerations.get(relativePath);
            if (lastEventGeneration !== undefined && lastEventGeneration <= snapshotGeneration) {
                removable.push(relativePath);
            }
        }
        if (removable.length === 0)
            return 0;
        for (const relativePath of removable) {
            this.dirty.delete(relativePath);
            this.pathGenerations.delete(relativePath);
        }
        this.nextGeneration();
        return removable.length;
    }
    async refreshIfNeeded() {
        if (!this.needsGitRefresh)
            return;
        await this.refreshFromGit(false);
    }
    async refreshFromGit(replace) {
        if (this.refreshPromise) {
            if (replace)
                this.replaceAfterRefresh = true;
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
    async acknowledgeIndexedCommit(commit, observedCurrentCommit) {
        if (!commit || !this.gitRepository)
            return;
        let current = observedCurrentCommit;
        if (current === undefined) {
            try {
                current = (await this.commandRunner("git", ["-C", this.root, "rev-parse", "HEAD"])).stdout.trim();
            }
            catch {
                return;
            }
        }
        if (current !== commit)
            return;
        await this.refreshFromGit(true);
    }
    async snapshot() {
        if (this.trackingStarted && !this.watcherHealthy)
            this.needsGitRefresh = true;
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
        const tombstones = new Set();
        await mapLimited([...paths], 64, async (relativePath) => {
            try {
                await access(path.join(this.root, relativePath));
            }
            catch {
                tombstones.add(relativePath);
            }
        });
        return { paths, tombstones, generation };
    }
    async runGitRefresh(replace) {
        const refreshStartedAt = this.generation;
        this.coverageTrusted = false;
        this.needsGitRefresh = false;
        let output;
        try {
            const result = await this.commandRunner("git", ["-C", this.root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowExitCodes: [0] });
            output = result.stdout;
            this.gitRepository = true;
        }
        catch {
            this.gitRepository = false;
            this.needsGitRefresh = true;
            return;
        }
        const next = new Set();
        const records = output.split("\0");
        for (let index = 0; index < records.length; index += 1) {
            const record = records[index];
            if (!record || record.length < 4)
                continue;
            const status = record.slice(0, 2);
            const relativePath = record.slice(3);
            const normalized = toPosix(relativePath);
            if (!ignored(normalized))
                next.add(normalized);
            if (status.includes("R") || status.includes("C")) {
                const original = records[index + 1];
                if (original) {
                    const originalNormalized = toPosix(original);
                    if (!ignored(originalNormalized))
                        next.add(originalNormalized);
                    index += 1;
                }
            }
        }
        const desired = replace ? new Set(next) : new Set(this.dirty);
        if (!replace) {
            for (const relativePath of next)
                desired.add(relativePath);
        }
        else {
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
        if (removed.length === 0 && added.length === 0)
            return;
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
    nextGeneration() {
        this.generation += 1;
        return this.generation;
    }
    notify(generation, headMayHaveChanged) {
        for (const listener of this.listeners)
            listener(generation, headMayHaveChanged);
    }
}
async function mapLimited(values, concurrency, visit) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (next < values.length) {
            const index = next;
            next += 1;
            await visit(values[index]);
        }
    });
    await Promise.all(workers);
}
