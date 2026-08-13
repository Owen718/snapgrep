export interface SearchRequest {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  beforeContext?: number;
  afterContext?: number;
  limit?: number | null;
  multiline?: boolean;
  hidden?: boolean;
  noIgnore?: boolean;
}

export interface MatchRange {
  absoluteStart: number;
  absoluteEnd: number;
  lineStart: number;
  lineEnd: number;
}

export interface SearchMatch {
  path: string;
  absolutePath: string;
  lineNumber: number;
  lineText: string;
  ranges: MatchRange[];
  before: string[];
  after: string[];
}

export type RequestedBackend =
  | "auto"
  | "instant"
  | "normal"
  | "fff"
  | "kernel"
  | "kernel-dev";

export type SearchBackend =
  | "zoekt"
  | "kernel"
  | "fff"
  | "rg"
  | "rg_fallback";

export interface SearchTimings {
  totalMs: number;
  healthMs?: number;
  /** Full loopback request including HTTP, body I/O, and JSON decoding. */
  indexQueryMs?: number;
  /** Zoekt Result.Duration reported by the Go server. */
  indexServerMs?: number;
  indexTransportSerializationMs?: number;
  indexJsonDecodeMs?: number;
  coverageQueryMs?: number;
  coverageServerMs?: number;
  coverageTransportSerializationMs?: number;
  coverageJsonDecodeMs?: number;
  verifyMs?: number;
  binaryReconciliationMs?: number;
  formatMs?: number;
}

export interface SearchMetadata {
  requestedBackend: RequestedBackend;
  actualBackend: SearchBackend;
  fallbackReason?: string;
  indexedCommit?: string;
  currentCommit?: string;
  indexFilesConsidered?: number;
  indexFilesLoaded?: number;
  indexMatchCount?: number;
  /** Complete Zoekt content-match lines used directly before coverage reconciliation. */
  indexExactMatchLines?: number;
  /** Existing files represented by Zoekt's NOT-INDEXED marker. */
  unindexedFiles?: number;
  /** Binary candidates subjected to tree-mode reconciliation. */
  binaryFilesSkipped?: number;
  /** Files whose worktree content is transformed by Git LFS and cannot trust the Git-blob index. */
  filteredWorktreeFiles?: number;
  overlayRevision?: number;
  overlayFiles?: number;
  dirtyFiles: number;
  realtimeFiles: number;
  totalMatches: number;
  /** False means totalMatches is a proven lower bound because indexed candidates were capped. */
  totalMatchesExact?: boolean;
  displayedMatches: number;
  truncated: boolean;
  timings: SearchTimings;
}

export interface SearchResult {
  matches: SearchMatch[];
  metadata: SearchMetadata;
}

/** A content match returned by Zoekt before the engine attaches the repository root. */
export interface IndexedExactMatch {
  path: string;
  lineNumber: number;
  lineText: string;
  ranges: MatchRange[];
}

export interface CandidateResult {
  files: string[];
  /**
   * Present only when Zoekt returned a complete, byte-validated content-match
   * result for every path outside exactMatchCarriageReturnPaths. Absence means
   * the engine must retain the existing ripgrep verifier.
   */
  exactMatches?: IndexedExactMatch[];
  /**
   * Indexed paths whose matching response line contained CR. Their untrusted
   * Zoekt offsets are omitted from exactMatches and require whole-file ripgrep
   * verification before the engine may merge the result.
   */
  exactMatchCarriageReturnPaths?: string[];
  indexedCommit?: string;
  baseVersionState: "consistent" | "missing" | "mixed" | "no_base_files";
  filesConsidered: number;
  filesLoaded: number;
  matchCount: number;
  /**
   * Full client-observed request round trip, from request serialization through
   * reading the response body and decoding its JSON.
   *
   * Kept as the compatibility timing consumed by the engine. It is deliberately
   * not Zoekt's server-side Result.Duration.
   */
  durationMs: number;
  /** Explicit alias for durationMs, so profiling code does not have to infer its scope. */
  roundTripMs: number;
  /** Zoekt Result.Duration converted from nanoseconds, when the server reports it. */
  serverDurationMs?: number;
  /** Time spent in the client's JSON.parse call. */
  jsonDecodeMs: number;
  /**
   * Remaining round-trip time after server execution and client JSON decoding.
   * This includes HTTP transport, response-body I/O, and request/response
   * serialization that cannot be measured separately at this interface.
   */
  transportSerializationMs: number;
  truncated: boolean;
}

export interface DirtySnapshot {
  paths: ReadonlySet<string>;
  tombstones: ReadonlySet<string>;
  generation: number;
}
