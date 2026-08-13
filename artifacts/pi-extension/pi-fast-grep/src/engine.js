import { lstat, open, stat } from "node:fs/promises";
import path from "node:path";
import { DirtyCoverageError, DirtyTracker } from "./dirty-tracker.js";
import { IndexManager } from "./index-manager.js";
import { planZoektQuery } from "./query-plan.js";
import { runCommand } from "./process.js";
import { listRipgrepFiles, runRipgrep } from "./rg.js";
import { ZoektClient } from "./zoekt-client.js";
const RIPGREP_INITIAL_BINARY_SCAN_BYTES = 64 * 1024;
const EXPANDED_CANDIDATE_LIMIT = 100_000;
/**
 * Retry a truncated default-cap candidate query once with a bounded larger cap.
 *
 * The returned result describes the expanded query. Only timings are accumulated
 * across both requests so callers can report the actual amount of Zoekt work.
 */
export async function searchCandidatesWithBoundedExpansion(search, options) {
    options.signal?.throwIfAborted();
    const initial = await search(options.initialMaxFiles, options.signal);
    if (!initial.truncated
        || options.maxCandidateFilesConfigured
        || options.initialMaxFiles >= EXPANDED_CANDIDATE_LIMIT) {
        return initial;
    }
    options.signal?.throwIfAborted();
    const expanded = await search(EXPANDED_CANDIDATE_LIMIT, options.signal);
    const { durationMs: expandedDurationMs, roundTripMs: expandedRoundTripMs, serverDurationMs: expandedServerDurationMs, jsonDecodeMs: expandedJsonDecodeMs, transportSerializationMs: expandedTransportSerializationMs, ...expandedResult } = expanded;
    return {
        ...expandedResult,
        durationMs: initial.durationMs + expandedDurationMs,
        roundTripMs: initial.roundTripMs + expandedRoundTripMs,
        jsonDecodeMs: initial.jsonDecodeMs + expandedJsonDecodeMs,
        transportSerializationMs: initial.transportSerializationMs + expandedTransportSerializationMs,
        ...(initial.serverDurationMs !== undefined && expandedServerDurationMs !== undefined
            ? { serverDurationMs: initial.serverDurationMs + expandedServerDurationMs }
            : {}),
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isAbort(error) {
    return error instanceof Error && error.name === "AbortError";
}
function matchKey(match) {
    const ranges = match.ranges
        .map((range) => `${range.absoluteStart}:${range.absoluteEnd}`)
        .join(",");
    return `${match.path}\0${match.lineNumber}\0${ranges}`;
}
function compareMatches(left, right) {
    // Match ripgrep backend ordering exactly. localeCompare is locale-sensitive
    // and, on macOS, can place lowercase paths before uppercase paths while the
    // normal backend uses deterministic code-point order.
    if (left.path < right.path)
        return -1;
    if (left.path > right.path)
        return 1;
    if (left.lineNumber !== right.lineNumber)
        return left.lineNumber - right.lineNumber;
    return (left.ranges[0]?.absoluteStart ?? 0) - (right.ranges[0]?.absoluteStart ?? 0);
}
function mergeMatches(groups) {
    const seen = new Set();
    const merged = [];
    for (const group of groups) {
        for (const match of group) {
            const key = matchKey(match);
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(match);
        }
    }
    merged.sort(compareMatches);
    return merged;
}
function normalizeRequest(request) {
    const normalized = {
        ...request,
        hidden: request.hidden ?? true,
        context: request.context ?? 2,
        limit: request.limit === null ? null : Math.max(1, Math.floor(request.limit ?? 100)),
    };
    return normalized;
}
async function existingPaths(root, paths, signal) {
    const result = [];
    await mapLimited([...paths], 64, async (relativePath) => {
        if (signal?.aborted)
            throw abortError();
        const absolutePath = path.join(root, relativePath);
        try {
            const info = await lstat(absolutePath);
            if (info.isFile())
                result.push(relativePath);
        }
        catch {
            // A tombstone intentionally contributes no real-time match.
        }
    });
    return result;
}
export class FastGrepEngine {
    root;
    indexManager;
    dirtyTracker;
    requestedBackend;
    zoektTimeoutMs;
    maxCandidateFiles;
    eligibleFilesCache = new Map();
    unindexedFilesCache;
    filteredFilesCache;
    indexedBinaryCache;
    acknowledgedCommit;
    dirtyUnsubscribe;
    overlayTimer;
    overlayPromise;
    overlayRequested = false;
    overlayLastError;
    startPromise;
    stopPromise;
    started = false;
    stopping = false;
    lifecycleEpoch = 0;
    constructor(options) {
        this.root = path.resolve(options.root);
        this.indexManager = options.indexManager ?? new IndexManager({ root: this.root, ...options.indexOptions });
        this.dirtyTracker =
            options.dirtyTracker ??
                new DirtyTracker(this.root, {
                    ...(options.initialDirtyPaths === undefined
                        ? {}
                        : { initialDirtyPaths: options.initialDirtyPaths }),
                });
        this.requestedBackend = options.requestedBackend ?? "auto";
        this.zoektTimeoutMs = options.zoektTimeoutMs ?? 750;
        this.maxCandidateFiles = options.maxCandidateFiles;
    }
    async start(options = {}) {
        if (this.stopPromise !== undefined)
            await this.stopPromise;
        const epoch = this.lifecycleEpoch;
        if (!this.started) {
            if (this.startPromise === undefined) {
                this.startPromise = (async () => {
                    // Install the project-local index ignore before DirtyTracker's first
                    // git-status snapshot, so our own shards never appear as user edits.
                    await this.indexManager.prepareRepositoryRuntime();
                    if (this.stopping || epoch !== this.lifecycleEpoch)
                        return;
                    await this.dirtyTracker.start();
                    if (this.stopping || epoch !== this.lifecycleEpoch) {
                        this.dirtyTracker.stop();
                        return;
                    }
                    this.dirtyUnsubscribe = this.dirtyTracker.onDirty((_generation, headMayHaveChanged) => {
                        if (headMayHaveChanged)
                            this.indexManager.invalidateCurrentCommit();
                        this.scheduleIncrementalIndex();
                    });
                    const commit = await this.indexManager.currentCommit();
                    if (this.stopping || epoch !== this.lifecycleEpoch) {
                        this.dirtyUnsubscribe?.();
                        this.dirtyUnsubscribe = undefined;
                        this.dirtyTracker.stop();
                        return;
                    }
                    this.acknowledgedCommit = commit;
                    this.started = true;
                    if (!this.indexManager.currentCommitSnapshot().known) {
                        this.scheduleIncrementalIndex(0);
                    }
                })().finally(() => {
                    this.startPromise = undefined;
                });
            }
            await this.startPromise;
        }
        if (!this.started || this.stopping || epoch !== this.lifecycleEpoch)
            return;
        const indexStart = this.indexManager.start();
        if (options.waitForIndex) {
            await indexStart;
            if (this.started && !this.stopping && epoch === this.lifecycleEpoch) {
                this.scheduleIncrementalIndex(0);
            }
        }
        else {
            void indexStart.then(() => {
                if (this.started && !this.stopping && epoch === this.lifecycleEpoch) {
                    this.scheduleIncrementalIndex(0);
                }
            }, () => undefined);
        }
    }
    async stop() {
        if (this.stopPromise !== undefined)
            return this.stopPromise;
        this.lifecycleEpoch += 1;
        this.stopping = true;
        this.started = false;
        this.overlayRequested = false;
        this.dirtyUnsubscribe?.();
        this.dirtyUnsubscribe = undefined;
        if (this.overlayTimer !== undefined)
            clearTimeout(this.overlayTimer);
        this.overlayTimer = undefined;
        this.dirtyTracker.stop();
        // Stop the manager before awaiting an overlay so its active index command
        // is aborted immediately. IndexManager.stop() is itself a quiescence
        // barrier for initialization, refresh, overlay, restart, and webserver
        // ownership.
        const managerStop = this.indexManager.stop();
        const stopPromise = Promise.all([
            managerStop,
            this.startPromise?.catch(() => undefined) ?? Promise.resolve(),
            this.overlayPromise?.catch(() => undefined) ?? Promise.resolve(),
        ]).then(() => undefined);
        this.stopPromise = stopPromise;
        try {
            await stopPromise;
        }
        finally {
            if (this.overlayTimer !== undefined)
                clearTimeout(this.overlayTimer);
            this.overlayTimer = undefined;
            this.overlayRequested = false;
            this.stopping = false;
            if (this.stopPromise === stopPromise)
                this.stopPromise = undefined;
        }
    }
    markToolPath(value, cwd = this.root) {
        this.dirtyTracker.markToolPath(value, cwd);
    }
    markWorkspaceUnknown() {
        this.dirtyTracker.markWorkspaceUnknown();
    }
    async flushIncrementalIndex(timeoutMs = 5_000) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new RangeError("timeoutMs must be positive");
        }
        if (!this.started || this.stopping) {
            throw new Error("Cannot flush the incremental index while the engine is stopped");
        }
        if (this.overlayTimer !== undefined)
            clearTimeout(this.overlayTimer);
        this.overlayTimer = undefined;
        this.overlayRequested = true;
        const work = this.runIncrementalIndex();
        let timeout;
        try {
            await Promise.race([
                work,
                new Promise((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error(`incremental index did not become ready within ${timeoutMs} ms`)), timeoutMs);
                    timeout.unref();
                }),
            ]);
            if (this.overlayLastError !== undefined)
                throw this.overlayLastError;
        }
        finally {
            if (timeout !== undefined)
                clearTimeout(timeout);
        }
    }
    scheduleIncrementalIndex(delayMs = 100) {
        if (!this.started || this.stopping)
            return;
        this.overlayRequested = true;
        if (this.overlayPromise !== undefined)
            return;
        if (this.overlayTimer !== undefined)
            clearTimeout(this.overlayTimer);
        this.overlayTimer = setTimeout(() => {
            this.overlayTimer = undefined;
            void this.runIncrementalIndex();
        }, delayMs);
        this.overlayTimer.unref();
    }
    runIncrementalIndex() {
        if (!this.started || this.stopping)
            return Promise.resolve();
        if (this.overlayPromise !== undefined)
            return this.overlayPromise;
        this.overlayPromise = this.incrementalIndexLoop().finally(() => {
            this.overlayPromise = undefined;
            if (this.overlayRequested && this.started && !this.stopping) {
                this.scheduleIncrementalIndex(250);
            }
        });
        return this.overlayPromise;
    }
    async incrementalIndexLoop() {
        while (this.overlayRequested && this.started && !this.stopping) {
            this.overlayRequested = false;
            try {
                await this.indexManager.start();
                if (!this.started || this.stopping)
                    return;
                await this.indexManager.refreshIfNeeded();
                if (!this.started || this.stopping)
                    return;
                const status = this.indexManager.status();
                if (!this.indexManager.ready || status.mode !== "git")
                    return;
                const snapshot = await this.dirtyTracker.snapshot();
                if (snapshot.paths.size === 0) {
                    this.overlayLastError = undefined;
                    return;
                }
                await this.indexManager.updateWorkspaceOverlay(snapshot.paths, snapshot.generation);
                this.dirtyTracker.acknowledgeIndexedPaths(snapshot.paths, snapshot.generation);
                this.unindexedFilesCache = undefined;
                this.overlayLastError = undefined;
                const latest = await this.dirtyTracker.snapshot();
                if (latest.paths.size > 0)
                    this.overlayRequested = true;
            }
            catch (error) {
                if (this.stopping || !this.started)
                    return;
                this.overlayLastError = error instanceof Error ? error : new Error(String(error));
                return;
            }
        }
    }
    async search(rawRequest, options = {}) {
        const startedAt = performance.now();
        const request = normalizeRequest(rawRequest);
        const requestedBackend = options.backend ?? this.requestedBackend;
        if (requestedBackend === "normal") {
            return runRipgrep(this.root, request, {
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                actualBackend: "rg",
                requestedBackend: "normal",
            });
        }
        if (!this.started)
            await this.start({ waitForIndex: false });
        let dirty;
        try {
            await this.dirtyTracker.refreshIfNeeded();
            dirty = await this.dirtyTracker.snapshot();
        }
        catch (error) {
            if (!(error instanceof DirtyCoverageError))
                throw error;
            return this.fallback(request, `workspace dirty coverage unavailable: ${error.message}`, startedAt, 0, options.signal, requestedBackend);
        }
        if (dirty.paths.size > 0)
            this.scheduleIncrementalIndex();
        const searchRoot = path.resolve(this.root, request.path ?? ".");
        if (!isWithin(this.root, searchRoot)) {
            return this.fallback(request, "search path is outside the indexed repository root", startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
        const repositoryRelativeSearchRoot = path
            .relative(this.root, searchRoot)
            .split(path.sep)
            .join("/");
        const plan = planZoektQuery(request, { repositoryRelativeSearchRoot });
        if (!plan.eligible) {
            return this.fallback(request, plan.fallbackReason, startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
        const status = this.indexManager.status();
        if (!this.indexManager.ready || !this.indexManager.url) {
            this.indexManager.startInBackground();
            return this.fallback(request, `index unavailable (${status.lifecycle})`, startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
        if (status.mode !== "git") {
            return this.fallback(request, "non-Git workspace index is not trusted across sessions; using recall-safe ripgrep", startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
        if (status.submodulesPresent) {
            return this.fallback(request, "repository has submodules that are not covered by the base Zoekt shard", startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
        const commitBeforeQuery = this.indexManager.currentCommitSnapshot();
        const currentCommit = commitBeforeQuery.commit;
        if (!commitBeforeQuery.known || currentCommit === undefined) {
            this.scheduleIncrementalIndex(0);
            return this.fallback(request, "repository HEAD freshness is pending", startedAt, dirty.paths.size, options.signal, requestedBackend, {
                ...(status.indexedCommit === undefined ? {} : { indexedCommit: status.indexedCommit }),
            });
        }
        if (status.mode === "git" && currentCommit !== status.indexedCommit) {
            this.indexManager.refreshInBackground();
            return this.fallback(request, "index commit is stale", startedAt, dirty.paths.size, options.signal, requestedBackend, {
                ...(currentCommit === undefined ? {} : { currentCommit }),
                ...(status.indexedCommit === undefined ? {} : { indexedCommit: status.indexedCommit }),
            });
        }
        if (status.mode === "git" &&
            status.indexedCommit !== undefined &&
            this.acknowledgedCommit !== status.indexedCommit) {
            await this.dirtyTracker.acknowledgeIndexedCommit(status.indexedCommit, currentCommit);
            this.acknowledgedCommit = status.indexedCommit;
            try {
                dirty = await this.dirtyTracker.snapshot();
            }
            catch (error) {
                if (!(error instanceof DirtyCoverageError))
                    throw error;
                return this.fallback(request, `workspace dirty coverage unavailable: ${error.message}`, startedAt, 0, options.signal, requestedBackend);
            }
            if (dirty.paths.size > 0)
                this.scheduleIncrementalIndex();
        }
        let candidates;
        let unindexed;
        try {
            const initialCandidateLimit = this.candidateLimit(request);
            const client = new ZoektClient({
                baseUrl: this.indexManager.url,
                timeoutMs: this.zoektTimeoutMs,
                maxFiles: initialCandidateLimit,
            });
            [candidates, unindexed] = await Promise.all([
                searchCandidatesWithBoundedExpansion((maxFiles, signal) => client.search(plan, {
                    ...(signal === undefined ? {} : { signal }),
                    maxFiles,
                }), {
                    initialMaxFiles: initialCandidateLimit,
                    maxCandidateFilesConfigured: this.maxCandidateFiles !== undefined,
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                }),
                this.unindexedFiles(this.indexManager.url, status.indexedCommit, status.overlayRevision ?? 0, options.signal),
            ]);
        }
        catch (error) {
            if (isAbort(error) || options.signal?.aborted)
                throw error;
            void this.indexManager.restartWebserver().catch(() => undefined);
            return this.fallback(request, `sidecar query or index-coverage check failed: ${errorMessage(error)}`, startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
        if (candidates.baseVersionState === "missing" || candidates.baseVersionState === "mixed") {
            return this.fallback(request, `sidecar base-shard version is ${candidates.baseVersionState}`, startedAt, dirty.paths.size, options.signal, requestedBackend, {
                ...(currentCommit === undefined ? {} : { currentCommit }),
                ...(status.indexedCommit === undefined ? {} : { indexedCommit: status.indexedCommit }),
            });
        }
        if (candidates.indexedCommit !== undefined &&
            status.indexedCommit !== undefined &&
            candidates.indexedCommit !== status.indexedCommit) {
            return this.fallback(request, "sidecar served a different indexed commit", startedAt, dirty.paths.size, options.signal, requestedBackend, {
                ...(currentCommit === undefined ? {} : { currentCommit }),
                indexedCommit: status.indexedCommit,
            });
        }
        const commitAfterQuery = this.indexManager.currentCommitSnapshot();
        if (status.mode === "git"
            && (!commitAfterQuery.known
                || commitAfterQuery.generation !== commitBeforeQuery.generation
                || commitAfterQuery.commit !== currentCommit)) {
            this.indexManager.refreshInBackground();
            return this.fallback(request, "repository commit changed during the indexed query", startedAt, dirty.paths.size, options.signal, requestedBackend, {
                ...(commitAfterQuery.commit === undefined ? {} : { currentCommit: commitAfterQuery.commit }),
                ...(status.indexedCommit === undefined ? {} : { indexedCommit: status.indexedCommit }),
            });
        }
        // A truncated candidate set requires a tree-wide fallback before spending
        // any time on candidate verification or binary classification.
        if (candidates.truncated) {
            return this.fallback(request, "candidate set was truncated, so exact ordering and totals require ripgrep", startedAt, dirty.paths.size, options.signal, requestedBackend, {
                ...(currentCommit === undefined ? {} : { currentCommit }),
                ...(status.indexedCommit === undefined ? {} : { indexedCommit: status.indexedCommit }),
            });
        }
        const dirtyPaths = dirty.paths;
        const indexedOverlayPaths = this.indexManager.workspaceOverlayPaths();
        const overlayPaths = new Set([
            ...dirtyPaths,
            ...indexedOverlayPaths,
            ...unindexed.excludedPaths,
        ]);
        const cleanCandidates = candidates.files.filter((relativePath) => !overlayPaths.has(relativePath));
        const realtimeCandidates = await existingPaths(this.root, new Set([...dirtyPaths, ...indexedOverlayPaths]), options.signal);
        const verificationRequest = { ...request, limit: null };
        try {
            const binaryCacheKey = `${status.indexedCommit ?? `workspace:${status.indexDir}`}\0${status.overlayRevision ?? 0}`;
            const explicitFileSearch = await requestTargetsRegularFile(this.root, request);
            const [indexedClassified, realtimeClassified] = explicitFileSearch
                ? [
                    {
                        paths: cleanCandidates,
                        binaryPaths: [],
                        carriageReturnPaths: [],
                        lateBinaryOffsets: new Map(),
                        binaryFiles: 0,
                    },
                    {
                        paths: realtimeCandidates,
                        binaryPaths: [],
                        carriageReturnPaths: [],
                        lateBinaryOffsets: new Map(),
                        binaryFiles: 0,
                    },
                ]
                : await Promise.all([
                    this.excludeBinaryPaths(cleanCandidates, binaryCacheKey, options.signal, true),
                    this.excludeBinaryPaths(realtimeCandidates, `dirty:${dirty.generation}`, options.signal, false),
                ]);
            const eligiblePaths = await this.eligibleFiles(request, dirty.generation, status.indexedCommit, status.overlayRevision ?? 0, options.signal);
            const binaryPaths = explicitFileSearch
                ? []
                : [...new Set([
                        ...indexedClassified.binaryPaths,
                        ...unindexed.binaryPaths,
                        ...realtimeClassified.binaryPaths,
                    ])];
            const lateBinaryOffsets = new Map();
            for (const source of [
                indexedClassified.lateBinaryOffsets,
                unindexed.lateBinaryOffsets,
                realtimeClassified.lateBinaryOffsets,
            ]) {
                for (const [relativePath, offset] of source) {
                    const previous = lateBinaryOffsets.get(relativePath);
                    if (previous === undefined || offset < previous)
                        lateBinaryOffsets.set(relativePath, offset);
                }
            }
            const verificationCandidates = explicitFileSearch
                ? [...cleanCandidates, ...unindexed.paths, ...unindexed.binaryPaths, ...realtimeCandidates]
                : [...indexedClassified.paths, ...unindexed.paths, ...realtimeClassified.paths];
            let allMatches;
            let binaryReconciled = false;
            let verificationMs;
            let usedExactMatches = false;
            if (candidates.exactMatches !== undefined && !explicitFileSearch) {
                usedExactMatches = true;
                const carriageReturnPaths = new Set([
                    ...indexedClassified.carriageReturnPaths,
                    ...(candidates.exactMatchCarriageReturnPaths ?? []),
                ]);
                const indexedCarriageReturnPaths = indexedClassified.paths.filter((relativePath) => carriageReturnPaths.has(relativePath));
                const directExcludedPaths = new Set([
                    ...overlayPaths,
                    ...binaryPaths,
                    ...indexedCarriageReturnPaths,
                ]);
                const directIndexedMatches = candidates.exactMatches
                    .filter((match) => eligiblePaths.has(match.path) && !directExcludedPaths.has(match.path))
                    .map((match) => ({
                    ...match,
                    absolutePath: path.join(this.root, match.path),
                    before: [],
                    after: [],
                }));
                const directCoverageCandidates = [
                    ...unindexed.paths,
                    ...realtimeClassified.paths,
                    ...indexedCarriageReturnPaths,
                ];
                const verificationStartedAt = performance.now();
                const [coverageVerified, lateBinaryProbe] = await Promise.all([
                    runRipgrep(this.root, verificationRequest, {
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                        candidates: directCoverageCandidates,
                        eligiblePaths,
                        actualBackend: "zoekt",
                        requestedBackend,
                    }),
                    runRipgrep(this.root, verificationRequest, {
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                        candidates: [...lateBinaryOffsets.keys()],
                        eligiblePaths,
                        actualBackend: "zoekt",
                        requestedBackend,
                    }),
                ]);
                binaryReconciled = lateBinaryProbe.matches.some((match) => {
                    const relativePath = match.path.replaceAll(path.sep, "/");
                    const firstNul = lateBinaryOffsets.get(relativePath);
                    return firstNul !== undefined
                        && match.ranges.some((range) => range.absoluteStart < firstNul);
                });
                const verifiedGroups = binaryReconciled
                    ? [
                        (await runRipgrep(this.root, verificationRequest, {
                            ...(options.signal === undefined ? {} : { signal: options.signal }),
                            actualBackend: "rg_fallback",
                            requestedBackend,
                        })).matches,
                    ]
                    : [directIndexedMatches, coverageVerified.matches];
                verificationMs = performance.now() - verificationStartedAt;
                allMatches = mergeMatches(verifiedGroups);
            }
            else {
                const verificationStartedAt = performance.now();
                const [candidateVerified, lateBinaryProbe] = await Promise.all([
                    runRipgrep(this.root, verificationRequest, {
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                        candidates: verificationCandidates,
                        eligiblePaths,
                        actualBackend: "zoekt",
                        requestedBackend,
                    }),
                    runRipgrep(this.root, verificationRequest, {
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                        candidates: [...lateBinaryOffsets.keys()],
                        eligiblePaths,
                        actualBackend: "zoekt",
                        requestedBackend,
                    }),
                ]);
                // ripgrep's directory walker suppresses a binary file immediately when
                // the first NUL is in its initial 64 KiB scan. For a later NUL it can
                // emit an implementation-dependent prefix of matches before declaring
                // the file binary. Explicit candidate operands intentionally have a
                // different policy, so a pre-NUL match in a late-binary candidate needs
                // one exact tree-mode reconciliation. This is rare; early-NUL assets no
                // longer force an unnecessary full-repository scan.
                binaryReconciled = lateBinaryProbe.matches.some((match) => {
                    const relativePath = match.path.replaceAll(path.sep, "/");
                    const firstNul = lateBinaryOffsets.get(relativePath);
                    return firstNul !== undefined
                        && match.ranges.some((range) => range.absoluteStart < firstNul);
                });
                const verified = binaryReconciled
                    ? await runRipgrep(this.root, verificationRequest, {
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                        actualBackend: "rg_fallback",
                        requestedBackend,
                    })
                    : candidateVerified;
                verificationMs = performance.now() - verificationStartedAt;
                allMatches = mergeMatches([verified.matches]);
            }
            const requestedLimit = request.limit === null ? null : (request.limit ?? 100);
            const displayed = requestedLimit === null ? allMatches : allMatches.slice(0, requestedLimit);
            const truncated = displayed.length < allMatches.length;
            const latestDirty = await this.dirtyTracker.snapshot();
            if (latestDirty.generation !== dirty.generation) {
                return this.fallback(request, "workspace changed during the indexed query", startedAt, latestDirty.paths.size, options.signal, requestedBackend);
            }
            const totalMs = performance.now() - startedAt;
            return {
                matches: displayed,
                metadata: {
                    requestedBackend,
                    actualBackend: binaryReconciled ? "rg_fallback" : "zoekt",
                    ...(binaryReconciled
                        ? { fallbackReason: "late binary candidate requires exact tree-mode ripgrep reconciliation" }
                        : {}),
                    ...(status.indexedCommit === undefined ? {} : { indexedCommit: status.indexedCommit }),
                    ...(currentCommit === undefined ? {} : { currentCommit }),
                    indexFilesConsidered: candidates.filesConsidered,
                    indexFilesLoaded: candidates.filesLoaded,
                    indexMatchCount: candidates.matchCount,
                    ...(usedExactMatches
                        ? { indexExactMatchLines: candidates.exactMatches?.length ?? 0 }
                        : {}),
                    unindexedFiles: unindexed.excludedPaths.length,
                    binaryFilesSkipped: binaryPaths.length,
                    filteredWorktreeFiles: unindexed.filteredFiles,
                    overlayRevision: status.overlayRevision ?? 0,
                    overlayFiles: status.overlayFiles ?? 0,
                    dirtyFiles: dirtyPaths.size,
                    realtimeFiles: unindexed.excludedPaths.length + realtimeCandidates.length,
                    totalMatches: allMatches.length,
                    totalMatchesExact: true,
                    displayedMatches: displayed.length,
                    truncated,
                    timings: {
                        totalMs,
                        indexQueryMs: candidates.durationMs,
                        ...(candidates.serverDurationMs === undefined
                            ? {}
                            : { indexServerMs: candidates.serverDurationMs }),
                        indexTransportSerializationMs: candidates.transportSerializationMs,
                        indexJsonDecodeMs: candidates.jsonDecodeMs,
                        coverageQueryMs: unindexed.queryMs,
                        ...(unindexed.serverMs === undefined ? {} : { coverageServerMs: unindexed.serverMs }),
                        coverageTransportSerializationMs: unindexed.transportSerializationMs,
                        coverageJsonDecodeMs: unindexed.jsonDecodeMs,
                        ...(verificationMs === undefined ? {} : { verifyMs: verificationMs }),
                        ...(binaryReconciled && verificationMs !== undefined
                            ? { binaryReconciliationMs: verificationMs }
                            : {}),
                    },
                },
            };
        }
        catch (error) {
            if (isAbort(error) || options.signal?.aborted)
                throw error;
            return this.fallback(request, error instanceof DirtyCoverageError
                ? `workspace dirty coverage unavailable: ${error.message}`
                : `candidate verification failed: ${errorMessage(error)}`, startedAt, dirty.paths.size, options.signal, requestedBackend);
        }
    }
    candidateLimit(request) {
        if (this.maxCandidateFiles !== undefined)
            return this.maxCandidateFiles;
        if (request.limit === null)
            return 1_000_000;
        return Math.max(10_000, (request.limit ?? 100) * 20);
    }
    async unindexedFiles(baseUrl, indexedCommit, overlayRevision, signal) {
        const key = `${baseUrl}\0${indexedCommit ?? "workspace"}\0${overlayRevision}`;
        if (this.unindexedFilesCache?.key === key) {
            return {
                excludedPaths: this.unindexedFilesCache.excludedPaths,
                paths: this.unindexedFilesCache.paths,
                binaryPaths: this.unindexedFilesCache.binaryPaths,
                lateBinaryOffsets: this.unindexedFilesCache.lateBinaryOffsets,
                binaryFiles: this.unindexedFilesCache.binaryFiles,
                filteredFiles: this.unindexedFilesCache.filteredFiles,
                queryMs: 0,
                serverMs: 0,
                transportSerializationMs: 0,
                jsonDecodeMs: 0,
            };
        }
        const client = new ZoektClient({
            baseUrl,
            timeoutMs: Math.max(5_000, this.zoektTimeoutMs),
            maxFiles: 1_000_000,
        });
        const searchOptions = {
            ...(signal === undefined ? {} : { signal }),
            maxFiles: 1_000_000,
        };
        const [result, binaryResult, filteredPaths] = await Promise.all([
            client.search('type:file case:yes content:"NOT-INDEXED: "', searchOptions),
            client.search('type:file case:yes content:"NOT-INDEXED: contains binary content"', searchOptions),
            this.filteredWorktreePaths(indexedCommit),
        ]);
        if (result.truncated || binaryResult.truncated) {
            throw new Error("Zoekt's unindexed-file coverage list was truncated");
        }
        if (result.baseVersionState === "missing"
            || result.baseVersionState === "mixed"
            || binaryResult.baseVersionState === "missing"
            || binaryResult.baseVersionState === "mixed") {
            throw new Error("Zoekt's unindexed-file coverage came from an unverifiable base shard");
        }
        if (indexedCommit !== undefined &&
            result.indexedCommit !== undefined &&
            result.indexedCommit !== indexedCommit) {
            throw new Error("Zoekt's unindexed-file coverage list came from a different commit");
        }
        const excludedPaths = await existingPaths(this.root, new Set([...result.files, ...filteredPaths]), signal);
        const binary = new Set(binaryResult.files);
        const firstNulOffsets = new Map();
        await mapLimited(excludedPaths, 16, async (relativePath) => {
            const firstNul = await firstNulOffset(path.join(this.root, relativePath), signal);
            if (firstNul !== undefined) {
                binary.add(relativePath);
                firstNulOffsets.set(relativePath, firstNul);
            }
            else if (binary.has(relativePath)) {
                // Zoekt can conservatively classify content as binary for reasons other
                // than a NUL byte. Treat such a file as late-binary so any possible
                // match is reconciled by a real tree-mode rg query.
                firstNulOffsets.set(relativePath, Number.POSITIVE_INFINITY);
            }
        });
        const paths = excludedPaths.filter((relativePath) => !binary.has(relativePath));
        const binaryPaths = excludedPaths.filter((relativePath) => binary.has(relativePath));
        const lateBinaryOffsets = new Map(binaryPaths
            .map((relativePath) => [relativePath, firstNulOffsets.get(relativePath)])
            .filter((entry) => entry[1] !== undefined && entry[1] >= RIPGREP_INITIAL_BINARY_SCAN_BYTES));
        const cached = {
            key,
            excludedPaths,
            paths,
            binaryPaths,
            lateBinaryOffsets,
            binaryFiles: excludedPaths.length - paths.length,
            filteredFiles: filteredPaths.length,
            queryMs: Math.max(result.durationMs, binaryResult.durationMs),
            serverMs: maxOptional(result.serverDurationMs, binaryResult.serverDurationMs),
            transportSerializationMs: Math.max(result.transportSerializationMs, binaryResult.transportSerializationMs),
            jsonDecodeMs: Math.max(result.jsonDecodeMs, binaryResult.jsonDecodeMs),
        };
        this.unindexedFilesCache = cached;
        return cached;
    }
    async excludeBinaryPaths(relativePaths, cacheKey, signal, persist) {
        const uniquePaths = [...new Set(relativePaths)];
        const cache = persist
            ? this.binaryCache(cacheKey)
            : {
                key: cacheKey,
                classified: new Set(),
                binary: new Set(),
                carriageReturn: new Set(),
                firstNulOffsets: new Map(),
            };
        const unknown = uniquePaths.filter((relativePath) => !cache.classified.has(relativePath));
        await mapLimited(unknown, 16, async (relativePath) => {
            if (signal?.aborted)
                throw abortError();
            const markers = await scanFileMarkers(path.join(this.root, relativePath), signal);
            cache.classified.add(relativePath);
            if (markers.containsCarriageReturn)
                cache.carriageReturn.add(relativePath);
            if (markers.firstNulOffset !== undefined) {
                cache.binary.add(relativePath);
                cache.firstNulOffsets.set(relativePath, markers.firstNulOffset);
            }
        });
        const paths = uniquePaths.filter((relativePath) => !cache.binary.has(relativePath));
        const binaryPaths = uniquePaths.filter((relativePath) => cache.binary.has(relativePath));
        const carriageReturnPaths = uniquePaths.filter((relativePath) => cache.carriageReturn.has(relativePath));
        const lateBinaryOffsets = new Map(binaryPaths
            .map((relativePath) => [relativePath, cache.firstNulOffsets.get(relativePath)])
            .filter((entry) => entry[1] !== undefined && entry[1] >= RIPGREP_INITIAL_BINARY_SCAN_BYTES));
        return {
            paths,
            binaryPaths,
            carriageReturnPaths,
            lateBinaryOffsets,
            binaryFiles: binaryPaths.length,
        };
    }
    binaryCache(key) {
        if (this.indexedBinaryCache?.key !== key) {
            this.indexedBinaryCache = {
                key,
                classified: new Set(),
                binary: new Set(),
                carriageReturn: new Set(),
                firstNulOffsets: new Map(),
            };
        }
        return this.indexedBinaryCache;
    }
    async filteredWorktreePaths(indexedCommit) {
        const commit = indexedCommit ?? "workspace";
        if (this.filteredFilesCache?.commit === commit)
            return this.filteredFilesCache.paths;
        let paths = [];
        try {
            const result = await runCommand("git", ["-C", this.root, "lfs", "ls-files", "-n"]);
            paths = result.stdout
                .split("\n")
                .map((value) => value.trim())
                .filter((value) => value.length > 0 && isWithin(this.root, path.resolve(this.root, value)));
        }
        catch {
            // Git LFS is optional. Without a smudge-capable client the worktree normally
            // contains the same pointer blob Zoekt indexed, so there is no extra overlay.
        }
        const existing = await existingPaths(this.root, new Set(paths));
        this.filteredFilesCache = { commit, paths: existing };
        return existing;
    }
    async eligibleFiles(request, generation, indexedCommit, overlayRevision, signal) {
        const key = JSON.stringify({
            indexedCommit: indexedCommit ?? null,
            overlayRevision,
            path: request.path ?? ".",
            glob: request.glob ?? null,
            hidden: request.hidden ?? true,
            noIgnore: request.noIgnore ?? false,
        });
        const cached = this.eligibleFilesCache.get(key);
        if (cached?.generation === generation)
            return cached.paths;
        const paths = await listRipgrepFiles(this.root, request, signal);
        const latestGeneration = (await this.dirtyTracker.snapshot()).generation;
        if (latestGeneration === generation) {
            if (this.eligibleFilesCache.size >= 64) {
                const oldest = this.eligibleFilesCache.keys().next().value;
                if (oldest !== undefined)
                    this.eligibleFilesCache.delete(oldest);
            }
            this.eligibleFilesCache.set(key, { generation, paths });
        }
        return paths;
    }
    async fallback(request, reason, startedAt, dirtyFiles, signal, requestedBackend, commits = {}) {
        const result = await runRipgrep(this.root, request, {
            ...(signal === undefined ? {} : { signal }),
            actualBackend: "rg_fallback",
            requestedBackend,
        });
        result.metadata.fallbackReason = reason;
        result.metadata.dirtyFiles = dirtyFiles;
        result.metadata.realtimeFiles = dirtyFiles;
        result.metadata.timings.totalMs = performance.now() - startedAt;
        if (commits.indexedCommit !== undefined)
            result.metadata.indexedCommit = commits.indexedCommit;
        if (commits.currentCommit !== undefined)
            result.metadata.currentCommit = commits.currentCommit;
        return result;
    }
}
async function requestTargetsRegularFile(root, request) {
    if (request.path === undefined)
        return false;
    return (await stat(path.resolve(root, request.path))).isFile();
}
async function firstNulOffset(absolutePath, signal) {
    return (await scanFileMarkers(absolutePath, signal)).firstNulOffset;
}
async function scanFileMarkers(absolutePath, signal) {
    let handle;
    try {
        handle = await open(absolutePath, "r");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        let containsCarriageReturn = false;
        while (true) {
            if (signal?.aborted)
                throw abortError();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0)
                return { containsCarriageReturn };
            const chunk = buffer.subarray(0, bytesRead);
            if (chunk.includes(13))
                containsCarriageReturn = true;
            const relativeOffset = chunk.indexOf(0);
            if (relativeOffset >= 0) {
                return {
                    firstNulOffset: position + relativeOffset,
                    containsCarriageReturn,
                };
            }
            position += bytesRead;
        }
    }
    catch (error) {
        if (isAbort(error) || signal?.aborted)
            throw error;
        if (isNodeError(error) && error.code === "ENOENT") {
            return { containsCarriageReturn: false };
        }
        throw error;
    }
    finally {
        await handle?.close().catch(() => undefined);
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
function abortError() {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}
function maxOptional(left, right) {
    if (left === undefined)
        return right;
    if (right === undefined)
        return left;
    return Math.max(left, right);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
}
