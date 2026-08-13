import { createRequire } from "node:module";
import path from "node:path";

export const KERNEL_BINDING_ABI_VERSION = 10;

export type KernelBindingErrorCode =
  | "PFG_BINDING_ABI"
  | "PFG_BINDING_LOAD"
  | "PFG_BINDING_PATH"
  | "PFG_BINDING_SHAPE"
  | "PFG_BINDING_TARGET"
  | "PFG_RANGE_UNSAFE";

export class KernelBindingError extends Error {
  readonly code: KernelBindingErrorCode;

  constructor(code: KernelBindingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelBindingError";
    this.code = code;
  }
}

export interface NativeBuildStats {
  formatVersion: number;
  files: bigint;
  binaryFiles: bigint;
  grams: bigint;
  postings: bigint;
  indexBytes: bigint;
  buildDurationNs: bigint;
}

export interface NativeBuildWithSourceDigestStats extends NativeBuildStats {
  contentSha256: string;
  sourceBytes: bigint;
}

export interface NativeOpenStats {
  formatVersion: number;
  files: bigint;
  binaryFiles: bigint;
  grams: bigint;
  postings: bigint;
  indexBytes: bigint;
  openDurationNs: bigint;
}

export interface NativeOccurrence {
  path: string;
  absoluteStart: bigint;
  absoluteEnd: bigint;
}

export interface NativeQueryResult {
  occurrences: NativeOccurrence[];
  totalOccurrences: bigint;
  candidateFiles: bigint;
  binaryMatchFiles: string[];
  utf8BomCandidateFiles: string[];
  transcodedCandidateFiles: string[];
  unsafeTranscodedFiles: string[];
  unsafeCaseFoldFiles: string[];
  requiresFallback: boolean;
  queryDurationNs: bigint;
}

export interface NativeRegexCandidateResult {
  selectedGram: number;
  mandatoryGrams: bigint;
  candidatePaths: string[];
  candidateFiles: bigint;
  /** Unresolved binary candidates that can still match before their first raw NUL. */
  binaryCandidatePaths: string[];
  /** Valid UTF-8 BOM candidates that are exact in the native verifier. */
  utf8BomCandidatePaths: string[];
  /** Safe UTF-16 or malformed UTF-8 BOM candidates that still require ripgrep. */
  transcodedCandidatePaths: string[];
  unsafeTranscodedPaths: string[];
  complete: boolean;
  queryDurationNs: bigint;
}

export interface NativeVerifiedRange {
  absoluteStart: bigint;
  absoluteEnd: bigint;
  lineStart: bigint;
  lineEnd: bigint;
}

export interface NativeVerifiedMatch {
  path: string;
  lineNumber: bigint;
  lineText: string;
  ranges: NativeVerifiedRange[];
  before: string[];
  after: string[];
}

export interface NativeLiteralVerifyResult {
  matches: NativeVerifiedMatch[];
  totalMatches: bigint;
  totalOccurrences: bigint;
  indexedOccurrences: bigint;
  verifiedFiles: bigint;
  truncated: boolean;
  queryDurationNs: bigint;
}

export interface NativeRegexVerifyResult {
  matches: NativeVerifiedMatch[];
  totalMatches: bigint;
  verifiedFiles: bigint;
  truncated: boolean;
  queryDurationNs: bigint;
}

export interface NativeSourceContentDigest {
  contentSha256: string;
  files: bigint;
  sourceBytes: bigint;
  durationNs: bigint;
}

export interface NativeKernelIndex {
  readonly closed: boolean;
  readonly activeJobs: number;
  readonly openStats: NativeOpenStats;
  queryLiteral(
    literal: string,
    pathRoot?: string,
    globPattern?: string,
    ignoreAsciiCase?: boolean,
  ): NativeQueryResult;
  queryRegexCandidates(pattern: string): NativeRegexCandidateResult | null;
  verifyLiteralCandidates(
    literal: string,
    candidatePaths: string[],
    beforeCount: number,
    afterCount: number,
    jobId: number,
    matchLimit?: number,
    ignoreAsciiCase?: boolean,
  ): Promise<NativeLiteralVerifyResult>;
  verifyRegexCandidates(
    pattern: string,
    candidatePaths: string[],
    beforeCount: number,
    afterCount: number,
    jobId: number,
    matchLimit?: number,
  ): Promise<NativeRegexVerifyResult>;
  cancelRegexVerification(jobId: number): boolean;
  close(): boolean;
}

export interface NativeKernelIndexClass {
  open(indexPath: string): NativeKernelIndex;
}

export interface NativeKernelBinding {
  readonly BINDING_ABI_VERSION: number;
  bindingTarget(): string;
  buildKernelIndex(
    root: string,
    relativePaths: string[],
    indexPath: string,
  ): NativeBuildStats;
  buildKernelIndexWithSourceDigest(
    root: string,
    relativePaths: string[],
    indexPath: string,
  ): NativeBuildWithSourceDigestStats;
  hashSourceContents(
    root: string,
    canonicalRoot: string,
    relativePaths: readonly string[],
  ): NativeSourceContentDigest;
  readonly KernelIndex: NativeKernelIndexClass;
}

const require = createRequire(import.meta.url);

function expectedRustTarget(): string {
  const operatingSystem = new Map<string, string>([
    ["darwin", "macos"],
    ["freebsd", "freebsd"],
    ["linux", "linux"],
    ["win32", "windows"],
  ]).get(process.platform);
  const architecture = new Map<string, string>([
    ["arm64", "aarch64"],
    ["ia32", "x86"],
    ["x64", "x86_64"],
  ]).get(process.arch);
  return `${operatingSystem ?? process.platform}-${architecture ?? process.arch}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadKernelBinding(addonPath: string): NativeKernelBinding {
  if (!path.isAbsolute(addonPath) || path.extname(addonPath) !== ".node") {
    throw new KernelBindingError(
      "PFG_BINDING_PATH",
      `kernel addon path must be an absolute .node path: ${addonPath}`,
    );
  }

  let raw: unknown;
  try {
    raw = require(addonPath);
  } catch (cause) {
    throw new KernelBindingError(
      "PFG_BINDING_LOAD",
      `failed to load kernel addon ${addonPath}`,
      { cause },
    );
  }
  if (
    !isRecord(raw)
    || typeof raw.BINDING_ABI_VERSION !== "number"
    || typeof raw.bindingTarget !== "function"
    || typeof raw.buildKernelIndex !== "function"
    || typeof raw.buildKernelIndexWithSourceDigest !== "function"
    || typeof raw.hashSourceContents !== "function"
    || typeof raw.KernelIndex !== "function"
    || typeof (raw.KernelIndex as { open?: unknown }).open !== "function"
    || typeof (raw.KernelIndex as {
      prototype?: {
        queryRegexCandidates?: unknown;
        verifyRegexCandidates?: unknown;
        cancelRegexVerification?: unknown;
      };
    }).prototype?.queryRegexCandidates !== "function"
    || typeof (raw.KernelIndex as {
      prototype?: { verifyRegexCandidates?: unknown };
    }).prototype?.verifyRegexCandidates !== "function"
    || typeof (raw.KernelIndex as {
      prototype?: {
        cancelRegexVerification?: unknown;
        verifyLiteralCandidates?: unknown;
      };
    }).prototype?.cancelRegexVerification !== "function"
    || typeof (raw.KernelIndex as {
      prototype?: { verifyLiteralCandidates?: unknown };
    }).prototype?.verifyLiteralCandidates !== "function"
  ) {
    throw new KernelBindingError(
      "PFG_BINDING_SHAPE",
      `kernel addon exports do not match ABI ${KERNEL_BINDING_ABI_VERSION}`,
    );
  }
  if (raw.BINDING_ABI_VERSION !== KERNEL_BINDING_ABI_VERSION) {
    throw new KernelBindingError(
      "PFG_BINDING_ABI",
      `kernel addon ABI ${raw.BINDING_ABI_VERSION} does not match ${KERNEL_BINDING_ABI_VERSION}`,
    );
  }
  const actualTarget = (raw.bindingTarget as () => unknown)();
  const expectedTarget = expectedRustTarget();
  if (actualTarget !== expectedTarget) {
    throw new KernelBindingError(
      "PFG_BINDING_TARGET",
      `kernel addon target ${String(actualTarget)} does not match ${expectedTarget}`,
    );
  }
  return raw as unknown as NativeKernelBinding;
}

export function bigintToSafeNumber(value: unknown, field: string): number {
  if (
    typeof value !== "bigint"
    || value < 0n
    || value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new KernelBindingError(
      "PFG_RANGE_UNSAFE",
      `${field} is not a non-negative safe JavaScript integer`,
    );
  }
  return Number(value);
}

export function nativeKernelErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /\[(PFG_[A-Z_]+)\]/u.exec(error.message)?.[1];
}
