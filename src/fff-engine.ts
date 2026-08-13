import {
  FileFinder,
  type GrepCursor,
  type GrepMatch,
  type GrepMode,
} from "@ff-labs/fff-node";
import path from "node:path";

import type { SearchMatch, SearchRequest, SearchResult } from "./types.js";

const DEFAULT_LIMIT = 100;
const FFF_READY_TIMEOUT_MS = 5 * 60_000;
const FFF_VERSION = "0.10.1" as const;

export interface FffStatus {
  version: typeof FFF_VERSION;
  ready: boolean;
  indexedFiles: number;
  initializationMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  rssDeltaBytes: number;
}

export interface FffQueryPlan {
  eligible: boolean;
  query?: string;
  mode?: GrepMode;
  unsupportedReason?: string;
}

interface NativeSearchResult {
  items: GrepMatch[];
  filteredFileCount: number;
  filesSearched: number;
  totalFiles: number;
  queryMs: number;
  hasMore: boolean;
}

export class FffUnsupportedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FffUnsupportedQueryError";
  }
}

function normalizedRequest(request: SearchRequest): SearchRequest {
  return {
    ...request,
    hidden: request.hidden ?? true,
    context: request.context ?? 2,
    limit: request.limit === null
      ? null
      : Math.max(1, Math.floor(request.limit ?? DEFAULT_LIMIT)),
  };
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Translate the public path/glob field to FFF's own query-constraint syntax.
 * This is input adaptation only: it never enumerates, filters, or repairs FFF's
 * native file universe.
 */
function normalizeNativeConstraint(
  rawConstraint: string,
  root: string,
  allowNegation: boolean,
): string | undefined {
  let constraint = rawConstraint.trim();
  if (constraint.length === 0) return undefined;

  let negated = false;
  if (allowNegation && constraint.startsWith("!")) {
    negated = true;
    constraint = constraint.slice(1);
  }
  if (constraint.length === 0) return undefined;
  if (/\s/u.test(constraint)) {
    throw new FffUnsupportedQueryError(
      `FFF native query syntax cannot encode whitespace in constraint: ${rawConstraint}`,
    );
  }

  if (path.isAbsolute(constraint)) {
    const absolute = path.resolve(constraint);
    if (!isWithin(root, absolute)) {
      throw new FffUnsupportedQueryError(
        `FFF native search path is outside the indexed root: ${rawConstraint}`,
      );
    }
    constraint = path.relative(root, absolute);
  }

  constraint = constraint.replaceAll(path.sep, "/").replace(/^\.\//u, "");
  if (constraint === "" || constraint === "." || constraint === "**" || constraint === "**/*") {
    return undefined;
  }

  const recursiveDirectory = constraint.match(/^(.*)\/\*\*(?:\/\*)?$/u);
  if (recursiveDirectory?.[1] && !/[*?[{]/u.test(recursiveDirectory[1])) {
    constraint = `${recursiveDirectory[1]}/`;
  } else if (
    !constraint.startsWith("/")
    && !constraint.endsWith("/")
    && !/[*?[{]/u.test(constraint)
  ) {
    const lastSegment = constraint.split("/").at(-1) ?? "";
    if (!/\.[A-Za-z][A-Za-z0-9]{0,9}$/u.test(lastSegment)) {
      constraint = `${constraint}/`;
    }
  }

  return negated ? `!${constraint}` : constraint;
}

/**
 * Map a grep request to FFF's native content-search API without constructing
 * an rg safety predicate. Unsupported requests are reported to the harness;
 * they never fall back to rg inside the FFF baseline.
 */
export function planFffQuery(
  request: SearchRequest,
  root = process.cwd(),
): FffQueryPlan {
  if (request.multiline) {
    return {
      eligible: false,
      unsupportedReason: "FFF native content search is line-oriented and does not support multiline grep",
    };
  }
  if (request.pattern.length === 0 || request.pattern.includes("\n")) {
    return {
      eligible: false,
      unsupportedReason: "FFF native content search cannot represent an empty or newline-containing pattern",
    };
  }

  try {
    const constraints = [
      ...(request.path === undefined
        ? []
        : [normalizeNativeConstraint(request.path, path.resolve(root), false)]),
      ...(request.glob === undefined
        ? []
        : [normalizeNativeConstraint(request.glob, path.resolve(root), true)]),
    ].filter((value): value is string => value !== undefined);
    return {
      eligible: true,
      query: [...constraints, request.pattern].join(" "),
      mode: request.literal === true ? "plain" : "regex",
    };
  } catch (error) {
    return {
      eligible: false,
      unsupportedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function normalizeNativeMatch(root: string, item: GrepMatch): SearchMatch {
  const relativePath = item.relativePath
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
  const absolutePath = path.resolve(root, relativePath);
  if (!isWithin(root, absolutePath)) {
    throw new Error(`FFF returned a path outside its indexed root: ${item.relativePath}`);
  }
  return {
    path: relativePath,
    absolutePath,
    lineNumber: item.lineNumber,
    lineText: item.lineContent,
    ranges: item.matchRanges.map(([start, end]) => ({
      absoluteStart: item.byteOffset + start,
      absoluteEnd: item.byteOffset + end,
      lineStart: start,
      lineEnd: end,
    })),
    before: item.contextBefore ?? [],
    after: item.contextAfter ?? [],
  };
}

function compareMatches(left: SearchMatch, right: SearchMatch): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.lineNumber !== right.lineNumber) return left.lineNumber - right.lineNumber;
  return (left.ranges[0]?.absoluteStart ?? 0) - (right.ranges[0]?.absoluteStart ?? 0);
}

export class FffEngine {
  readonly root: string;

  private finder: FileFinder | undefined;
  private statusValue: FffStatus | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get ready(): boolean {
    return this.statusValue?.ready === true;
  }

  status(): FffStatus {
    if (this.statusValue === undefined) throw new Error("FFF has not been started");
    return { ...this.statusValue };
  }

  async start(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FffStatus> {
    if (this.statusValue !== undefined) return this.status();
    options.signal?.throwIfAborted();
    const startedAt = performance.now();
    const rssBeforeBytes = process.memoryUsage.rss();

    // Native opponent configuration: do not override mmap/content-index/watch,
    // aiMode, or any cache budget.
    const created = FileFinder.create({ basePath: this.root });
    if (!created.ok) throw new Error(`FFF initialization failed: ${created.error}`);
    this.finder = created.value;

    try {
      const timeoutMs = options.timeoutMs ?? FFF_READY_TIMEOUT_MS;
      const completed = await this.finder.waitForScan(timeoutMs);
      options.signal?.throwIfAborted();
      if (!completed.ok) throw new Error(`FFF initial scan failed: ${completed.error}`);
      if (!completed.value) {
        throw new Error(`FFF initial scan did not complete within ${timeoutMs} ms`);
      }

      let indexedFiles = 0;
      const progress = this.finder.getScanProgress();
      if (!progress.ok) throw new Error(`FFF progress failed: ${progress.error}`);
      indexedFiles = progress.value.scannedFilesCount;
      const health = this.finder.healthCheck(this.root);
      if (health.ok) indexedFiles = health.value.filePicker.indexedFiles ?? indexedFiles;

      const rssAfterBytes = process.memoryUsage.rss();
      this.statusValue = {
        version: FFF_VERSION,
        ready: true,
        indexedFiles,
        initializationMs: performance.now() - startedAt,
        rssBeforeBytes,
        rssAfterBytes,
        rssDeltaBytes: Math.max(0, rssAfterBytes - rssBeforeBytes),
      };
      return this.status();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.finder?.destroy();
    this.finder = undefined;
    this.statusValue = undefined;
  }

  markWorkspaceChanged(): void {
    // Native FFF owns freshness through its default watcher. There is no
    // wrapper-side eligibility or coverage cache to invalidate.
  }

  async search(
    rawRequest: SearchRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<SearchResult> {
    const startedAt = performance.now();
    options.signal?.throwIfAborted();
    const request = normalizedRequest(rawRequest);
    if (!this.ready) {
      await this.start({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }

    const plan = planFffQuery(request, this.root);
    if (!plan.eligible || plan.query === undefined || plan.mode === undefined) {
      throw new FffUnsupportedQueryError(
        plan.unsupportedReason ?? "FFF native content search cannot represent this request",
      );
    }

    const native = this.searchNative(
      { query: plan.query, mode: plan.mode },
      request,
      options.signal,
    );
    const matches = native.items.map((item) => normalizeNativeMatch(this.root, item));
    const requestedLimit = request.limit === null
      ? null
      : (request.limit ?? DEFAULT_LIMIT);
    const nativeDisplayed = requestedLimit === null
      ? matches
      : matches.slice(0, requestedLimit);
    // Canonical ordering is structural normalization for the shared formatter
    // and occurrence comparator. The selected native result set is unchanged.
    const displayed = [...nativeDisplayed].sort(compareMatches);
    const truncated = displayed.length < matches.length || native.hasMore;
    const totalMs = performance.now() - startedAt;

    return {
      matches: displayed,
      metadata: {
        requestedBackend: "fff",
        actualBackend: "fff",
        indexFilesConsidered: native.filteredFileCount,
        indexFilesLoaded: native.filesSearched,
        indexMatchCount: native.items.length,
        dirtyFiles: 0,
        realtimeFiles: 0,
        totalMatches: matches.length,
        totalMatchesExact: !native.hasMore,
        displayedMatches: displayed.length,
        truncated,
        timings: {
          totalMs,
          indexQueryMs: native.queryMs,
        },
      },
    };
  }

  private searchNative(
    plan: Required<Pick<FffQueryPlan, "query" | "mode">>,
    request: SearchRequest,
    signal?: AbortSignal,
  ): NativeSearchResult {
    const finder = this.finder;
    if (finder === undefined) throw new Error("FFF is not started");
    const startedAt = performance.now();
    const items: GrepMatch[] = [];
    const requestedLimit = request.limit === null
      ? null
      : (request.limit ?? DEFAULT_LIMIT);
    const context = normalizeNonNegativeInteger(request.context);
    const beforeContext = normalizeNonNegativeInteger(request.beforeContext ?? context);
    const afterContext = normalizeNonNegativeInteger(request.afterContext ?? context);
    let cursor: GrepCursor | null = null;
    let filteredFileCount = 0;
    let filesSearched = 0;
    let totalFiles = 0;
    let hasMore = false;
    let pages = 0;
    const seenCursors = new Set<string>();

    do {
      if (signal?.aborted) throw abortError();
      const page = finder.grep(plan.query, {
        mode: plan.mode,
        cursor,
        beforeContext,
        afterContext,
      });
      if (!page.ok) throw new Error(`FFF native content search failed: ${page.error}`);
      if (page.value.regexFallbackError !== undefined) {
        throw new FffUnsupportedQueryError(
          `FFF native regex is unsupported and would fall back to literal: ${page.value.regexFallbackError}`,
        );
      }

      items.push(...page.value.items);
      filteredFileCount = Math.max(filteredFileCount, page.value.filteredFileCount);
      filesSearched += page.value.totalFilesSearched;
      totalFiles = Math.max(totalFiles, page.value.totalFiles);
      cursor = page.value.nextCursor;
      pages += 1;

      if (requestedLimit !== null && items.length >= requestedLimit) {
        hasMore = cursor !== null;
        break;
      }
      if (pages > 100_000) throw new Error("FFF native pagination exceeded 100000 pages");
      if (cursor !== null) {
        const cursorKey = JSON.stringify(cursor);
        if (seenCursors.has(cursorKey)) {
          throw new Error("FFF native search returned a repeated pagination cursor");
        }
        seenCursors.add(cursorKey);
      }
    } while (cursor !== null);

    return {
      items,
      filteredFileCount,
      filesSearched,
      totalFiles,
      queryMs: performance.now() - startedAt,
      hasMore,
    };
  }
}
