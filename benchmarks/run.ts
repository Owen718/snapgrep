#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FastGrepEngine } from "../src/engine.js";
import { formatSearchResult } from "../src/format.js";
import { runCommand } from "../src/process.js";
import { runRipgrep } from "../src/rg.js";
import type { SearchMatch, SearchMetadata, SearchRequest, SearchResult } from "../src/types.js";
import {
  assertImplementationHashEvidence,
  computeImplementationHash,
  type ImplementationHashEvidence,
} from "./implementation-hash.js";

export const SAFE_RUNNER_SCHEMA_VERSION = "pi-fast-grep-benchmark-runner/v6-safe" as const;
export const QUERY_TIMEOUT_MS = 60_000;
export const ROUND_TIMEOUT_MS = 180_000;
export const TREE_RSS_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
export const NODE_OLD_SPACE_LIMIT_MB = 2048;
export const INDEX_LIMIT_BYTES = 100 * 1024 * 1024;
export const ARTIFACT_LIMIT_BYTES = 20 * 1024 * 1024;
export const DIFFERENCE_EXAMPLE_LIMIT = 100;
const RSS_POLL_INTERVAL_MS = 100;
const RSS_RECORD_INTERVAL_MS = 1_000;
const DEFAULT_ITERATIONS = 7;
const DEFAULT_WARMUPS = 3;
const DEFAULT_OUTPUT = "artifacts/results/benchmark-v3-results.json";
const SAFETY_PROOF_PATH = "artifacts/results/benchmark-v3-safety-proof.json";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_PATH = fileURLToPath(import.meta.url);
const TAIL_ROOT = path.join(PROJECT_ROOT, ".bench", "repos", "Tail-synthetic");
const TYPICAL_ROOT = path.join(PROJECT_ROOT, ".bench", "repos", "Typical-vite");
const CORE_FIXTURE = path.join(PROJECT_ROOT, "benchmarks", "fixtures", "core");
const CORE_TEMP_PREFIX = "pi-fast-grep-safe-core-";
const CORPUS_MARKER = ".benchmark-corpus.json";
const WORKER_TOKEN_ENV = "PI_FAST_GREP_SAFE_WORKER_TOKEN";
const WORKER_FLAG = "--safe-worker";
const SAFETY_PROBE_ENV = "PI_FAST_GREP_BENCHMARK_SAFETY_PROBE";
const ZOEKT_COMMIT = "3c8b39b1ef4f8194cb912d7e6581cff9db224aa7";

export type RepoName = "Core" | "Tail" | "Typical-vite";
export type QueryCategory = string;
export type ExpectedRoute = "index_preferred" | "fallback_required";
export type ExpectedOutcome = "matches" | "no_matches" | "invalid_regex";
type Backend = "normal" | "instant";
type SafetyProbe = "timeout" | "rss" | "lifecycle" | "all";

export interface BenchmarkQuery {
  id: string;
  category: QueryCategory;
  request: SearchRequest;
  performance?: true;
  capacityPreflight?: true;
  description?: string;
  expectedRoute?: ExpectedRoute;
  expectedOutcome?: ExpectedOutcome;
}

interface QueryMatrixDocument {
  schemaVersion: "fast-grep-benchmark-queries/v2-safe";
  repo: RepoName;
  snapshot: string;
  queries: Array<{
    id: string;
    category: string;
    description: string;
    request: SearchRequest;
    expectedRoute: ExpectedRoute;
    performanceEligible: boolean;
    capacityPreflight?: boolean;
    expected: { outcome: ExpectedOutcome };
  }>;
}

interface CorpusDefinition {
  name: RepoName;
  directory: string;
  source: string;
  language: string;
  matrixPath: string;
  temporary: boolean;
}

const CORPORA: Record<RepoName, CorpusDefinition> = {
  Core: {
    name: "Core",
    directory: CORE_FIXTURE,
    source: "benchmarks/fixtures/core",
    language: "mixed fixture",
    matrixPath: path.join(PROJECT_ROOT, "benchmarks", "queries", "v3-core.json"),
    temporary: true,
  },
  Tail: {
    name: "Tail",
    directory: TAIL_ROOT,
    source: "deterministic synthetic corpus",
    language: "mixed synthetic",
    matrixPath: path.join(PROJECT_ROOT, "benchmarks", "queries", "v3-tail.json"),
    temporary: false,
  },
  "Typical-vite": {
    name: "Typical-vite",
    directory: TYPICAL_ROOT,
    source: "https://github.com/vitejs/vite",
    language: "TypeScript",
    matrixPath: path.join(PROJECT_ROOT, "benchmarks", "queries", "v3-typical-vite.json"),
    temporary: false,
  },
};

export interface CliOptions {
  repos: RepoName[];
  runCorrectness: boolean;
  runPerformance: boolean;
  iterations: number;
  warmups: number;
  outputPath: string;
  resume: boolean;
  rebuild: boolean;
  queryFilters: string[];
  maxPerformanceQueries?: number;
  safetyProbe?: SafetyProbe;
}

export interface Occurrence {
  path: string;
  start: number;
  end: number;
}

interface WorkerMetadata {
  actualBackend?: SearchMetadata["actualBackend"];
  fallbackReason?: string;
  timings?: SearchMetadata["timings"];
  totalMatches?: number;
  displayedMatches?: number;
  truncated?: boolean;
}

interface CorrectnessWorkerHeader {
  type: "header";
  outcome: "success" | "error";
  backend: Backend;
  wallMs: number;
  metadata?: WorkerMetadata;
  error?: string;
  indexBytes: number;
}

interface OccurrenceRecord extends Occurrence {
  type: "occurrence";
}

interface WorkerFooter {
  type: "footer";
  count: number;
  sha256: string;
}

type CorrectnessProtocolRecord = CorrectnessWorkerHeader | OccurrenceRecord | WorkerFooter;

interface PerformanceSample {
  iteration: number;
  order: "rg-instant" | "instant-rg";
  rgMs: number;
  instantMs: number;
  pairWallMs: number;
  rgOccurrences: number;
  instantOccurrences: number;
  outputEquivalent: boolean;
  missingDisplayed: Occurrence[];
  extraDisplayed: Occurrence[];
  instantBackend: SearchMetadata["actualBackend"];
  fallbackReason?: string;
  rgTimings: SearchMetadata["timings"];
  instantTimings: SearchMetadata["timings"];
}

interface PerformanceWorkerResult {
  type: "performance-result";
  samples: PerformanceSample[];
  indexBytes: number;
}

interface WorkerFailure {
  type: "worker-error";
  error: string;
}

interface CorrectnessDescriptor {
  mode: "correctness";
  authorization: string;
  corpus: RepoName;
  root: string;
  backend: Backend;
  request: SearchRequest;
  safetyAllocationBytes?: number;
}

interface PerformanceDescriptor {
  mode: "performance";
  authorization: string;
  corpus: RepoName;
  root: string;
  request: SearchRequest;
  warmups: number;
  iterations: number;
}

interface ProbeDescriptor {
  mode: "probe-timeout" | "probe-rss" | "probe-quick";
  authorization: string;
}

type WorkerDescriptor = CorrectnessDescriptor | PerformanceDescriptor | ProbeDescriptor;
type WorkerLaunchDescriptor =
  | Omit<CorrectnessDescriptor, "authorization">
  | Omit<PerformanceDescriptor, "authorization">
  | Omit<ProbeDescriptor, "authorization">;

export interface CorrectnessQueryResult {
  id: string;
  category: string;
  description?: string;
  request: SearchRequest;
  fingerprint: string;
  status: "passed" | "failed" | "error";
  normalMs?: number;
  instantMs?: number;
  normalOccurrences?: number;
  instantOccurrences?: number;
  actualBackend?: SearchMetadata["actualBackend"];
  fallbackReason?: string;
  expectedRoute?: ExpectedRoute;
  expectedOutcome?: ExpectedOutcome;
  missing: Occurrence[];
  extra: Occurrence[];
  missingCount: number;
  extraCount: number;
  normalError?: string;
  instantError?: string;
  timedOut?: boolean;
  indexBytes: number;
  error?: string;
}

export interface CorrectnessPhase {
  querySetHash: string;
  completed: boolean;
  passed: boolean;
  queryCount: number;
  completedQueries: number;
  failedQueries: number;
  errorQueries: number;
  missingOccurrences: number;
  extraOccurrences: number;
  queries: CorrectnessQueryResult[];
  completedAt?: string;
}

interface TimingStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PerformanceQueryResult {
  id: string;
  category: string;
  description?: string;
  request: SearchRequest;
  fingerprint: string;
  status: "passed" | "failed" | "error";
  warmups: number;
  iterations: number;
  samples: PerformanceSample[];
  rg?: TimingStats;
  instant?: TimingStats;
  worstRegressionRatio?: number;
  timedOut?: boolean;
  indexBytes: number;
  error?: string;
}

export interface PerformancePhase {
  querySetHash: string;
  completed: boolean;
  passed: boolean;
  warmups: number;
  iterations: number;
  percentileMethod: "R-7 linear interpolation";
  queries: PerformanceQueryResult[];
  worstInstantP50Ms?: number;
  worstInstantQuery?: string;
  regressionsOverTenPercent: string[];
  completedAt?: string;
}

interface CapacityPreflightResult {
  queryId: string;
  passed: boolean;
  wallMs: number;
  missingCount: number;
  extraCount: number;
  normalOccurrences: number;
  instantOccurrences: number;
  indexBytes: number;
  timedOut: boolean;
  error?: string;
}

interface CorpusResult {
  name: RepoName;
  source: string;
  language: string;
  path: string;
  snapshot: string;
  trackedFiles: number;
  contentBytes: number;
  queryCorpusHash: string;
  state: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  capacityPreflight?: CapacityPreflightResult;
  correctness?: CorrectnessPhase;
  performance?: PerformancePhase;
  maxIndexBytes: number;
  errors: string[];
}

interface RssSample {
  elapsedMs: number;
  rssBytes: number;
  pids: number[];
}

interface ResourceEvidence {
  startedAt: string;
  completedAt?: string;
  wallMs: number;
  peakTreeRssBytes: number;
  peakTreePids: number[];
  rssSamples: RssSample[];
  maxIndexBytes: number;
  artifactBytes: number;
  queryTimeouts: number;
  childProcessesStarted: number;
  watchdogTriggered: boolean;
  wallTimeoutTriggered: boolean;
  breach?: string;
}

interface CompletionGate {
  correctness: "PASS" | "FAIL" | "INCOMPLETE";
  tailLatency: "PASS" | "FAIL" | "INCOMPLETE";
  typicalNoHarm: "PASS" | "FAIL" | "INCOMPLETE";
  resources: "PASS" | "FAIL";
  tailWorstInstantP50Ms?: number;
  typicalRegressions?: string[];
}

export interface BenchmarkArtifact {
  schemaVersion: 1;
  runnerSchemaVersion: typeof SAFE_RUNNER_SCHEMA_VERSION;
  implementationHash: ImplementationHashEvidence;
  generatedAt: string;
  projectRoot: string;
  outputPath: string;
  runtime: { node: string; platform: NodeJS.Platform; arch: string };
  limits: {
    roundWallMs: number;
    treeRssBytes: number;
    nodeOldSpaceMb: number;
    indexBytes: number;
    artifactBytes: number;
    queryWallMs: number;
  };
  lastInvocation: {
    repos: RepoName[];
    correctness: boolean;
    performance: boolean;
    iterations: number;
    warmups: number;
    resume: boolean;
    rebuild: boolean;
    queryFilters: string[];
  };
  resources: ResourceEvidence;
  corpora: Partial<Record<RepoName, CorpusResult>>;
  gate: CompletionGate;
  errors: string[];
}

interface SafetyProof {
  schemaVersion: "pi-fast-grep-benchmark-safety-proof/v1";
  harnessHash: string;
  runtime: { node: string; platform: NodeJS.Platform; arch: string };
  generatedAt: string;
  timeout: {
    passed: boolean;
    timeoutMs: number;
    observedMs: number;
    killed: boolean;
    continued: boolean;
  };
  rss: {
    passed: boolean;
    limitBytes: number;
    triggeredAtBytes: number;
    killed: boolean;
  };
  lifecycle: {
    passed: boolean;
    workers: number;
    uniquePids: number;
    afterExitRssBytes: number[];
    workerPeakRssBytes: number[];
    growthBytes: number;
    monotonicLargeGrowth: boolean;
    remainingDescendants: number[];
  };
}

function usage(): string {
  return `Usage: npm run benchmark -- [options]\n\n` +
    `Safe corpora: Core, Tail, Typical-vite. R1/R2/R3 are disabled.\n\n` +
    `Options:\n` +
    `  --repo NAME              Select safe corpus (repeatable or comma-separated)\n` +
    `  --correctness-only       Skip performance\n` +
    `  --performance-only       Require compatible correctness in the same artifact\n` +
    `  --iterations N           Measured samples, 1-${DEFAULT_ITERATIONS} (default ${DEFAULT_ITERATIONS})\n` +
    `  --warmups N              Warmups, 0-${DEFAULT_WARMUPS} (default ${DEFAULT_WARMUPS})\n` +
    `  --query ID               Select exact query ID\n` +
    `  --output PATH            Artifact path\n` +
    `  --rebuild                Remove only the selected safe corpus index\n` +
    `  --no-resume              Start a new artifact\n` +
    `  --safety-probe MODE      timeout, rss, lifecycle, or all (requires env opt-in)\n`;
}

function requireInteger(value: string, flag: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer in [${minimum}, ${maximum}]`);
  }
  return parsed;
}

export function normalizeRepo(value: string): RepoName {
  const normalized = value.trim().toLowerCase();
  if (["r1", "linux", "r1-linux", "r2", "vscode", "r2-vscode", "r3", "kubernetes", "k8s", "r3-kubernetes"].includes(normalized)) {
    throw new Error(`Repository ${JSON.stringify(value)} is permanently disabled by the benchmark-v3 host-safety policy`);
  }
  if (normalized === "core") return "Core";
  if (normalized === "tail" || normalized === "synthetic" || normalized === "tail-synthetic") return "Tail";
  if (normalized === "typical" || normalized === "vite" || normalized === "typical-vite") return "Typical-vite";
  throw new Error(`Unknown safe corpus ${JSON.stringify(value)}; expected Core, Tail, or Typical-vite`);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const selected: RepoName[] = [];
  let correctnessOnly = false;
  let performanceOnly = false;
  let iterations = DEFAULT_ITERATIONS;
  let warmups = DEFAULT_WARMUPS;
  let outputPath = path.join(PROJECT_ROOT, DEFAULT_OUTPUT);
  let resume = true;
  let rebuild = false;
  const queryFilters: string[] = [];
  let maxPerformanceQueries: number | undefined;
  let safetyProbe: SafetyProbe | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--correctness-only") correctnessOnly = true;
    else if (arg === "--performance-only") performanceOnly = true;
    else if (arg === "--no-resume") resume = false;
    else if (arg === "--rebuild") rebuild = true;
    else if (["--repo", "--iterations", "--warmups", "--output", "--query", "--max-performance-queries", "--safety-probe"].includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--repo") for (const item of value.split(",")) selected.push(normalizeRepo(item));
      else if (arg === "--iterations") iterations = requireInteger(value, arg, 1, DEFAULT_ITERATIONS);
      else if (arg === "--warmups") warmups = requireInteger(value, arg, 0, DEFAULT_WARMUPS);
      else if (arg === "--output") outputPath = path.resolve(process.cwd(), value);
      else if (arg === "--query") queryFilters.push(value);
      else if (arg === "--max-performance-queries") maxPerformanceQueries = requireInteger(value, arg, 1, 15);
      else if (value === "timeout" || value === "rss" || value === "lifecycle" || value === "all") safetyProbe = value;
      else throw new Error(`Unknown safety probe ${JSON.stringify(value)}`);
    } else if (arg.startsWith("--repo=")) {
      for (const item of arg.slice(7).split(",")) selected.push(normalizeRepo(item));
    } else if (arg.startsWith("--query=")) queryFilters.push(arg.slice(8));
    else if (arg.startsWith("--output=")) outputPath = path.resolve(process.cwd(), arg.slice(9));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (correctnessOnly && performanceOnly) throw new Error("--correctness-only and --performance-only are mutually exclusive");
  return {
    repos: selected.length === 0 ? ["Core", "Tail", "Typical-vite"] : [...new Set(selected)],
    runCorrectness: !performanceOnly,
    runPerformance: !correctnessOnly,
    iterations,
    warmups,
    outputPath,
    resume,
    rebuild,
    queryFilters,
    ...(maxPerformanceQueries === undefined ? {} : { maxPerformanceQueries }),
    ...(safetyProbe === undefined ? {} : { safetyProbe }),
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directoryLogicalBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) total += (await lstat(absolute)).size;
    }
  };
  if (await exists(root)) await visit(root);
  return total;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: root })).stdout.trim();
}

async function initializeDeterministicGit(root: string): Promise<string> {
  await runCommand("git", ["init", "-q"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Fast Grep Benchmark"], { cwd: root });
  await runCommand("git", ["config", "user.email", "benchmark@example.invalid"], { cwd: root });
  await runCommand("git", ["add", "-f", "."], { cwd: root });
  await runCommand("git", ["commit", "-qm", "deterministic benchmark corpus"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
  return git(root, "rev-parse", "HEAD");
}

interface PreparedCorpus {
  definition: CorpusDefinition;
  root: string;
  snapshot: string;
  trackedFiles: number;
  contentBytes: number;
  cleanup: () => Promise<void>;
}

async function prepareCorpus(definition: CorpusDefinition): Promise<PreparedCorpus> {
  let root = definition.directory;
  let cleanup = async (): Promise<void> => {};
  if (definition.temporary) {
    root = await mkdtemp(path.join(tmpdir(), CORE_TEMP_PREFIX));
    await cp(definition.directory, root, { recursive: true });
    await writeFile(path.join(root, CORPUS_MARKER), `${JSON.stringify({ kind: "Core", safe: true })}\n`);
    await initializeDeterministicGit(root);
    cleanup = async () => rm(root, { recursive: true, force: true });
  }
  if (!(await exists(root))) {
    throw new Error(`${definition.name} corpus is missing at ${root}; corpus preparation is required before benchmarking`);
  }
  const snapshot = await git(root, "rev-parse", "HEAD");
  const statusOutput = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  if (statusOutput.length > 0) throw new Error(`${definition.name} corpus is dirty; refusing to benchmark`);
  const tracked = (await git(root, "ls-files", "-z")).split("\0").filter(Boolean);
  let contentBytes = 0;
  for (const relative of tracked) {
    const info = await lstat(path.join(root, relative));
    if (info.isFile()) contentBytes += info.size;
  }
  return { definition, root, snapshot, trackedFiles: tracked.length, contentBytes, cleanup };
}

function requireMatrix(value: unknown, definition: CorpusDefinition): QueryMatrixDocument {
  if (!isObject(value) || value.schemaVersion !== "fast-grep-benchmark-queries/v2-safe" || value.repo !== definition.name || typeof value.snapshot !== "string" || !Array.isArray(value.queries)) {
    throw new Error(`Invalid safe query matrix header: ${definition.matrixPath}`);
  }
  const ids = new Set<string>();
  for (const [index, query] of value.queries.entries()) {
    if (!isObject(query) || typeof query.id !== "string" || typeof query.category !== "string" || typeof query.description !== "string" || !isObject(query.request) || typeof query.request.pattern !== "string" || (query.expectedRoute !== "index_preferred" && query.expectedRoute !== "fallback_required") || typeof query.performanceEligible !== "boolean" || !isObject(query.expected)) {
      throw new Error(`Invalid safe query matrix entry ${index}: ${definition.matrixPath}`);
    }
    if (ids.has(query.id)) throw new Error(`Duplicate query id ${query.id}`);
    ids.add(query.id);
  }
  return value as unknown as QueryMatrixDocument;
}

async function loadQueries(prepared: PreparedCorpus): Promise<{ queries: BenchmarkQuery[]; hash: string }> {
  const source = await readFile(prepared.definition.matrixPath, "utf8");
  const matrix = requireMatrix(JSON.parse(source) as unknown, prepared.definition);
  if (prepared.definition.name !== "Core" && matrix.snapshot !== prepared.snapshot) {
    throw new Error(`${prepared.definition.name} snapshot mismatch: matrix=${matrix.snapshot}, checkout=${prepared.snapshot}`);
  }
  const queries = matrix.queries.map((query) => ({
    id: query.id,
    category: query.category,
    description: query.description,
    request: query.request,
    expectedRoute: query.expectedRoute,
    expectedOutcome: query.expected.outcome,
    ...(query.performanceEligible ? { performance: true as const } : {}),
    ...(query.capacityPreflight ? { capacityPreflight: true as const } : {}),
  }));
  const performanceCount = queries.filter((query) => query.performance).length;
  if (performanceCount < 10 || performanceCount > 15) {
    throw new Error(`${prepared.definition.name} must have 10-15 performance queries, found ${performanceCount}`);
  }
  if (queries.filter((query) => query.capacityPreflight).length !== 1) {
    throw new Error(`${prepared.definition.name} must designate exactly one capacity preflight query`);
  }
  return { queries, hash: createHash("sha256").update(source).digest("hex") };
}

function correctnessRequest(query: BenchmarkQuery): SearchRequest {
  return { ...query.request, hidden: query.request.hidden ?? true, context: 0, beforeContext: 0, afterContext: 0, limit: null };
}

function performanceRequest(query: BenchmarkQuery): SearchRequest {
  return { ...query.request, hidden: query.request.hidden ?? true, context: 0, beforeContext: 0, afterContext: 0, limit: query.request.limit ?? 50 };
}

export function correctnessQuerySetHash(queries: readonly BenchmarkQuery[]): string {
  return stableHash(queries.map((query) => ({ id: query.id, category: query.category, request: correctnessRequest(query), expectedRoute: query.expectedRoute, expectedOutcome: query.expectedOutcome })));
}

export function performanceQueryFingerprint(query: BenchmarkQuery): string {
  return stableHash({ id: query.id, category: query.category, request: performanceRequest(query) });
}

function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

function timingStats(values: readonly number[]): TimingStats {
  if (values.length === 0) throw new Error("Cannot summarize empty timings");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function normalizePath(root: string, match: SearchMatch): string {
  const candidate = path.isAbsolute(match.path) ? path.relative(root, match.path) : match.path;
  return candidate.replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

function compareOccurrence(left: Occurrence, right: Occurrence): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return left.start - right.start || left.end - right.end;
}

function displayedOccurrenceMap(root: string, result: SearchResult): Map<string, Occurrence> {
  const map = new Map<string, Occurrence>();
  for (const match of result.matches) {
    const relative = normalizePath(root, match);
    for (const range of match.ranges) {
      const occurrence = { path: relative, start: range.absoluteStart, end: range.absoluteEnd };
      map.set(`${relative}\0${occurrence.start}\0${occurrence.end}`, occurrence);
    }
  }
  return map;
}

function boundedMapDifference(left: ReadonlyMap<string, Occurrence>, right: ReadonlyMap<string, Occurrence>): Occurrence[] {
  const examples: Occurrence[] = [];
  for (const [key, occurrence] of left) {
    if (!right.has(key) && examples.length < DIFFERENCE_EXAMPLE_LIMIT) examples.push(occurrence);
  }
  examples.sort(compareOccurrence);
  return examples;
}

function includeFormatTiming(result: SearchResult, request: SearchRequest): void {
  const started = performance.now();
  void formatSearchResult(result, request);
  const formatMs = performance.now() - started;
  result.metadata.timings.formatMs = formatMs;
  result.metadata.timings.totalMs += formatMs;
}

async function timedSearch(root: string, backend: Backend, request: SearchRequest): Promise<{ result: SearchResult; wallMs: number; indexBytes: number }> {
  let engine: FastGrepEngine | undefined;
  try {
    if (backend === "instant") {
      engine = new FastGrepEngine({ root, requestedBackend: "instant" });
      await engine.start({ waitForIndex: true });
    }
    const started = performance.now();
    const result = backend === "normal"
      ? await runRipgrep(root, request, { actualBackend: "rg", requestedBackend: "normal" })
      : await engine!.search(request, { backend: "instant" });
    includeFormatTiming(result, request);
    const wallMs = performance.now() - started;
    const statusBytes = engine?.indexManager.status().indexBytes ?? 0;
    const diskBytes = backend === "instant"
      ? await directoryLogicalBytes(path.join(root, ".pi", "index", "fast-grep"))
      : 0;
    return { result, wallMs, indexBytes: Math.max(statusBytes, diskBytes) };
  } finally {
    await engine?.stop();
  }
}

async function writeStdoutLine(value: unknown): Promise<void> {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, "drain");
}

async function assertWorkerRoot(corpus: RepoName, root: string): Promise<void> {
  const resolved = await realpath(root);
  if (corpus === "Tail" && resolved === await realpath(TAIL_ROOT)) return;
  if (corpus === "Typical-vite" && resolved === await realpath(TYPICAL_ROOT)) return;
  if (corpus === "Core" && path.basename(resolved).startsWith(CORE_TEMP_PREFIX)) {
    const marker = JSON.parse(await readFile(path.join(resolved, CORPUS_MARKER), "utf8")) as unknown;
    if (isObject(marker) && marker.kind === "Core" && marker.safe === true) return;
  }
  throw new Error(`Worker root is not an authorized safe corpus: ${resolved}`);
}

async function streamOccurrences(root: string, result: SearchResult): Promise<{ count: number; sha256: string }> {
  let previous: Occurrence | undefined;
  let count = 0;
  const hash = createHash("sha256");
  for (const match of result.matches) {
    const relative = normalizePath(root, match);
    for (const range of match.ranges) {
      const occurrence = { path: relative, start: range.absoluteStart, end: range.absoluteEnd };
      if (previous !== undefined) {
        const order = compareOccurrence(previous, occurrence);
        if (order > 0) throw new Error("SearchResult occurrence order is not stream-comparable");
        if (order === 0) continue;
      }
      const framed = `${Buffer.byteLength(relative)}:${relative}${occurrence.start}:${occurrence.end};`;
      hash.update(framed);
      await writeStdoutLine({ type: "occurrence", ...occurrence } satisfies OccurrenceRecord);
      previous = occurrence;
      count += 1;
    }
  }
  return { count, sha256: hash.digest("hex") };
}

function compactMetadata(metadata: SearchMetadata): WorkerMetadata {
  return {
    actualBackend: metadata.actualBackend,
    ...(metadata.fallbackReason === undefined ? {} : { fallbackReason: metadata.fallbackReason }),
    timings: metadata.timings,
    totalMatches: metadata.totalMatches,
    displayedMatches: metadata.displayedMatches,
    truncated: metadata.truncated,
  };
}

async function correctnessWorker(descriptor: CorrectnessDescriptor): Promise<void> {
  await assertWorkerRoot(descriptor.corpus, descriptor.root);
  let allocation: Buffer | undefined;
  if ((descriptor.safetyAllocationBytes ?? 0) > 0) {
    allocation = Buffer.allocUnsafe(descriptor.safetyAllocationBytes!);
    allocation.fill(0xa5);
  }
  try {
    const search = await timedSearch(descriptor.root, descriptor.backend, descriptor.request);
    await writeStdoutLine({
      type: "header",
      outcome: "success",
      backend: descriptor.backend,
      wallMs: search.wallMs,
      metadata: compactMetadata(search.result.metadata),
      indexBytes: search.indexBytes,
    } satisfies CorrectnessWorkerHeader);
    const footer = await streamOccurrences(descriptor.root, search.result);
    await writeStdoutLine({ type: "footer", ...footer } satisfies WorkerFooter);
  } catch (error) {
    await writeStdoutLine({
      type: "header",
      outcome: "error",
      backend: descriptor.backend,
      wallMs: 0,
      error: errorMessage(error),
      indexBytes: 0,
    } satisfies CorrectnessWorkerHeader);
    await writeStdoutLine({ type: "footer", count: 0, sha256: createHash("sha256").digest("hex") } satisfies WorkerFooter);
  } finally {
    allocation = undefined;
  }
}

async function performanceWorker(descriptor: PerformanceDescriptor): Promise<void> {
  await assertWorkerRoot(descriptor.corpus, descriptor.root);
  const engine = new FastGrepEngine({ root: descriptor.root, requestedBackend: "instant" });
  let maxIndexBytes = 0;
  const run = async (backend: Backend): Promise<{ result: SearchResult; wallMs: number }> => {
    const started = performance.now();
    const result = backend === "normal"
      ? await runRipgrep(descriptor.root, descriptor.request, { actualBackend: "rg", requestedBackend: "normal" })
      : await engine.search(descriptor.request, { backend: "instant" });
    includeFormatTiming(result, descriptor.request);
    return { result, wallMs: performance.now() - started };
  };
  try {
    await engine.start({ waitForIndex: true });
    maxIndexBytes = Math.max(
      engine.indexManager.status().indexBytes ?? 0,
      await directoryLogicalBytes(path.join(descriptor.root, ".pi", "index", "fast-grep")),
    );
    const total = descriptor.warmups + descriptor.iterations;
    const samples: PerformanceSample[] = [];
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      const order = ordinal % 2 === 0 ? "rg-instant" as const : "instant-rg" as const;
      const pairStarted = performance.now();
      let normal: Awaited<ReturnType<typeof run>>;
      let instant: Awaited<ReturnType<typeof run>>;
      if (order === "rg-instant") {
        normal = await run("normal");
        instant = await run("instant");
      } else {
        instant = await run("instant");
        normal = await run("normal");
      }
      if (ordinal < descriptor.warmups) continue;
      const normalMap = displayedOccurrenceMap(descriptor.root, normal.result);
      const instantMap = displayedOccurrenceMap(descriptor.root, instant.result);
      const missing = boundedMapDifference(normalMap, instantMap);
      const extra = boundedMapDifference(instantMap, normalMap);
      samples.push({
        iteration: ordinal - descriptor.warmups,
        order,
        rgMs: normal.wallMs,
        instantMs: instant.wallMs,
        pairWallMs: performance.now() - pairStarted,
        rgOccurrences: normalMap.size,
        instantOccurrences: instantMap.size,
        outputEquivalent: missing.length === 0 && extra.length === 0 && normalMap.size === instantMap.size,
        missingDisplayed: missing,
        extraDisplayed: extra,
        instantBackend: instant.result.metadata.actualBackend,
        ...(instant.result.metadata.fallbackReason === undefined ? {} : { fallbackReason: instant.result.metadata.fallbackReason }),
        rgTimings: normal.result.metadata.timings,
        instantTimings: instant.result.metadata.timings,
      });
    }
    await writeStdoutLine({ type: "performance-result", samples, indexBytes: maxIndexBytes } satisfies PerformanceWorkerResult);
  } finally {
    await engine.stop();
  }
}

async function workerMain(descriptorPath: string): Promise<void> {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as WorkerDescriptor;
  const token = process.env[WORKER_TOKEN_ENV];
  if (token === undefined || descriptor.authorization !== token) throw new Error("Unauthorized safe benchmark worker invocation");
  if (descriptor.mode === "probe-timeout") {
    for (;;) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (descriptor.mode === "probe-rss") {
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024 * 1024);
      chunk.fill(chunks.length & 0xff);
      chunks.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (descriptor.mode === "probe-quick") {
    await writeStdoutLine({ type: "probe-quick", ok: true });
    return;
  }
  if (descriptor.mode === "correctness") {
    await correctnessWorker(descriptor);
    return;
  }
  if (descriptor.mode === "performance") {
    await performanceWorker(descriptor);
    return;
  }
  throw new Error(`Unhandled worker mode: ${String((descriptor as { mode?: unknown }).mode)}`);
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  rssBytes: number;
}

export function parseProcessTable(output: string, excludedPid?: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 4) continue;
    const [pid, ppid, pgid, rssKiB] = fields.map(Number);
    if (
      pid !== undefined && ppid !== undefined && pgid !== undefined && rssKiB !== undefined
      && pid !== excludedPid
      && [pid, ppid, pgid, rssKiB].every((value) => Number.isSafeInteger(value) && value >= 0)
    ) {
      rows.push({ pid, ppid, pgid, rssBytes: rssKiB * 1024 });
    }
  }
  return rows;
}

export function processTreeFromRows(rows: readonly ProcessRow[], rootPid: number): { rssBytes: number; pids: number[] } {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const selected = rows.filter((row) => descendants.has(row.pid));
  return { rssBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0), pids: selected.map((row) => row.pid).sort((a, b) => a - b) };
}

async function processRows(): Promise<ProcessRow[]> {
  if (process.platform === "win32") throw new Error("Safe benchmark process-tree RSS watchdog is not implemented on Windows");
  const child = spawn("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { stdio: ["ignore", "pipe", "pipe"] });
  const observerPid = child.pid;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ps process-table sample failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
    });
  });
  return parseProcessTable(stdout, observerPid);
}

async function sampleTree(rootPid = process.pid): Promise<{ rssBytes: number; pids: number[] }> {
  return processTreeFromRows(await processRows(), rootPid);
}

async function killProcessGroup(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { allowExitCodes: [0, 128] }).catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(isObject(error) && error.code === "ESRCH")) throw error;
  }
}

async function processGroupMembers(pgid: number): Promise<number[]> {
  return (await processRows()).filter((row) => row.pgid === pgid).map((row) => row.pid);
}

class NdjsonReader {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private buffer = "";

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async next(): Promise<unknown | undefined> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        return JSON.parse(line) as unknown;
      }
      const next = await this.iterator.next();
      if (next.done) {
        if (this.buffer.length === 0) return undefined;
        const line = this.buffer;
        this.buffer = "";
        return JSON.parse(line) as unknown;
      }
      this.buffer += Buffer.isBuffer(next.value) ? next.value.toString("utf8") : next.value;
      if (this.buffer.length > 2 * 1024 * 1024) throw new Error("Worker protocol line exceeds 2 MiB");
    }
  }
}

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  wallMs: number;
  stderr: string;
  remainingGroupMembers: number[];
}

interface WorkerHandle {
  pid: number;
  reader: NdjsonReader;
  exit: Promise<WorkerExit>;
  kill: () => Promise<void>;
}

class WorkerSupervisor {
  readonly active = new Map<number, ChildProcessWithoutNullStreams>();
  queryTimeouts = 0;
  childrenStarted = 0;

  constructor(private readonly runDirectory: string) {}

  async start(descriptor: WorkerLaunchDescriptor, timeoutMs = QUERY_TIMEOUT_MS): Promise<WorkerHandle> {
    const authorization = randomUUID();
    const descriptorPath = path.join(this.runDirectory, `worker-${this.childrenStarted}-${randomUUID()}.json`);
    await writeFile(descriptorPath, `${JSON.stringify({ ...descriptor, authorization })}\n`, { mode: 0o600 });
    const started = performance.now();
    const child = spawn(process.execPath, [
      `--max-old-space-size=${NODE_OLD_SPACE_LIMIT_MB}`,
      "--import",
      "tsx",
      RUNNER_PATH,
      WORKER_FLAG,
      descriptorPath,
    ], {
      cwd: PROJECT_ROOT,
      detached: process.platform !== "win32",
      env: { ...process.env, [WORKER_TOKEN_ENV]: authorization },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    if (child.pid === undefined) throw new Error("Worker did not receive a PID");
    const pid = child.pid;
    this.active.set(pid, child);
    this.childrenStarted += 1;
    let timedOut = false;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      this.queryTimeouts += 1;
      void killProcessGroup(pid);
    }, timeoutMs);
    const exit = new Promise<WorkerExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", async (code, signal) => {
        clearTimeout(timer);
        this.active.delete(pid);
        const remaining = await processGroupMembers(pid).catch(() => []);
        if (remaining.length > 0) await killProcessGroup(pid).catch(() => undefined);
        await rm(descriptorPath, { force: true });
        resolve({ code, signal, timedOut, wallMs: performance.now() - started, stderr, remainingGroupMembers: remaining });
      });
    });
    return {
      pid,
      reader: new NdjsonReader(child.stdout),
      exit,
      kill: () => killProcessGroup(pid),
    };
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((pid) => killProcessGroup(pid).catch(() => undefined)));
  }
}

class ResourceBreachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceBreachError";
  }
}

class ResourceWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;
  private stopped = false;
  private lastRecordedAt = Number.NEGATIVE_INFINITY;
  private readonly started = performance.now();
  private fatal: ResourceBreachError | undefined;

  constructor(
    private readonly evidence: ResourceEvidence,
    private readonly supervisor: WorkerSupervisor,
    private readonly rssLimit = TREE_RSS_LIMIT_BYTES,
    private readonly wallLimit = ROUND_TIMEOUT_MS,
    private readonly expectedRssBreach = false,
  ) {}

  async start(): Promise<void> {
    await this.sample();
    this.timer = setInterval(() => void this.sample(), RSS_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    while (this.sampling) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.sample(true);
  }

  assertHealthy(): void {
    if (this.fatal !== undefined) throw this.fatal;
  }

  get breach(): ResourceBreachError | undefined {
    return this.fatal;
  }

  private async sample(forceRecord = false): Promise<void> {
    if ((this.stopped && !forceRecord) || this.sampling) return;
    this.sampling = true;
    try {
      const elapsedMs = performance.now() - this.started;
      const current = await sampleTree();
      if (current.rssBytes > this.evidence.peakTreeRssBytes) {
        this.evidence.peakTreeRssBytes = current.rssBytes;
        this.evidence.peakTreePids = current.pids;
      }
      if (forceRecord || elapsedMs - this.lastRecordedAt >= RSS_RECORD_INTERVAL_MS || current.rssBytes === this.evidence.peakTreeRssBytes) {
        this.evidence.rssSamples.push({ elapsedMs, rssBytes: current.rssBytes, pids: current.pids });
        if (this.evidence.rssSamples.length > 256) this.evidence.rssSamples.shift();
        this.lastRecordedAt = elapsedMs;
      }
      if (elapsedMs > this.wallLimit && this.fatal === undefined) {
        this.evidence.wallTimeoutTriggered = true;
        this.evidence.breach = `Round wall clock exceeded ${this.wallLimit} ms`;
        this.fatal = new ResourceBreachError(this.evidence.breach);
        await this.supervisor.killAll();
      }
      if (current.rssBytes > this.rssLimit && this.fatal === undefined) {
        this.evidence.watchdogTriggered = true;
        this.evidence.breach = `Process-tree RSS ${current.rssBytes} exceeded ${this.rssLimit}`;
        this.fatal = new ResourceBreachError(this.evidence.breach);
        await this.supervisor.killAll();
        if (this.expectedRssBreach) return;
      }
    } catch (error) {
      if (this.fatal === undefined) {
        this.evidence.breach = `RSS watchdog failed closed: ${errorMessage(error)}`;
        this.fatal = new ResourceBreachError(this.evidence.breach);
        await this.supervisor.killAll();
      }
    } finally {
      this.sampling = false;
    }
  }
}

function initialResources(): ResourceEvidence {
  return {
    startedAt: new Date().toISOString(),
    wallMs: 0,
    peakTreeRssBytes: 0,
    peakTreePids: [],
    rssSamples: [],
    maxIndexBytes: 0,
    artifactBytes: 0,
    queryTimeouts: 0,
    childProcessesStarted: 0,
    watchdogTriggered: false,
    wallTimeoutTriggered: false,
  };
}

export function artifactSerializedBytes(artifact: BenchmarkArtifact): number {
  return Buffer.byteLength(`${JSON.stringify(artifact, null, 2)}\n`);
}

async function atomicWriteArtifact(outputPath: string, artifact: BenchmarkArtifact): Promise<void> {
  artifact.generatedAt = new Date().toISOString();
  artifact.resources.artifactBytes = 0;
  let bytes = artifactSerializedBytes(artifact);
  artifact.resources.artifactBytes = bytes;
  bytes = artifactSerializedBytes(artifact);
  artifact.resources.artifactBytes = bytes;
  if (bytes > ARTIFACT_LIMIT_BYTES) throw new ResourceBreachError(`Artifact ${bytes} bytes exceeds ${ARTIFACT_LIMIT_BYTES}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, outputPath);
}

function newArtifact(options: CliOptions, implementationHash: ImplementationHashEvidence): BenchmarkArtifact {
  return {
    schemaVersion: 1,
    runnerSchemaVersion: SAFE_RUNNER_SCHEMA_VERSION,
    implementationHash,
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    outputPath: options.outputPath,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    limits: {
      roundWallMs: ROUND_TIMEOUT_MS,
      treeRssBytes: TREE_RSS_LIMIT_BYTES,
      nodeOldSpaceMb: NODE_OLD_SPACE_LIMIT_MB,
      indexBytes: INDEX_LIMIT_BYTES,
      artifactBytes: ARTIFACT_LIMIT_BYTES,
      queryWallMs: QUERY_TIMEOUT_MS,
    },
    lastInvocation: {
      repos: options.repos,
      correctness: options.runCorrectness,
      performance: options.runPerformance,
      iterations: options.iterations,
      warmups: options.warmups,
      resume: options.resume,
      rebuild: options.rebuild,
      queryFilters: options.queryFilters,
    },
    resources: initialResources(),
    corpora: {},
    gate: { correctness: "INCOMPLETE", tailLatency: "INCOMPLETE", typicalNoHarm: "INCOMPLETE", resources: "PASS" },
    errors: [],
  };
}

async function loadArtifact(options: CliOptions, implementationHash: ImplementationHashEvidence): Promise<BenchmarkArtifact> {
  if (!options.resume || !(await exists(options.outputPath))) return newArtifact(options, implementationHash);
  const parsed = JSON.parse(await readFile(options.outputPath, "utf8")) as unknown;
  if (!isObject(parsed) || parsed.runnerSchemaVersion !== SAFE_RUNNER_SCHEMA_VERSION || !isObject(parsed.corpora)) {
    throw new Error(`Cannot resume non-v6-safe artifact; use --no-resume: ${options.outputPath}`);
  }
  assertImplementationHashEvidence(parsed.implementationHash, implementationHash, "safe benchmark artifact");
  const artifact = parsed as unknown as BenchmarkArtifact;
  artifact.lastInvocation = newArtifact(options, implementationHash).lastInvocation;
  artifact.resources = initialResources();
  artifact.gate = { correctness: "INCOMPLETE", tailLatency: "INCOMPLETE", typicalNoHarm: "INCOMPLETE", resources: "PASS" };
  return artifact;
}

async function readProtocolRecord(reader: NdjsonReader): Promise<CorrectnessProtocolRecord | undefined> {
  const value = await reader.next();
  if (value === undefined) return undefined;
  if (!isObject(value) || typeof value.type !== "string") throw new Error("Invalid correctness worker protocol record");
  return value as unknown as CorrectnessProtocolRecord;
}

async function compareCorrectnessWorkers(
  supervisor: WorkerSupervisor,
  corpus: RepoName,
  root: string,
  request: SearchRequest,
  safetyAllocationBytes = 0,
): Promise<Omit<CorrectnessQueryResult, "id" | "category" | "request" | "fingerprint" | "status"> & { timedOut: boolean; workerWallMs: number }> {
  const [normal, instant] = await Promise.all([
    supervisor.start({ mode: "correctness", corpus, root, backend: "normal", request, ...(safetyAllocationBytes > 0 ? { safetyAllocationBytes } : {}) }),
    supervisor.start({ mode: "correctness", corpus, root, backend: "instant", request, ...(safetyAllocationBytes > 0 ? { safetyAllocationBytes } : {}) }),
  ]);
  let parseError: string | undefined;
  let normalHeader: CorrectnessWorkerHeader | undefined;
  let instantHeader: CorrectnessWorkerHeader | undefined;
  let normalFooter: WorkerFooter | undefined;
  let instantFooter: WorkerFooter | undefined;
  const missing: Occurrence[] = [];
  const extra: Occurrence[] = [];
  let missingCount = 0;
  let extraCount = 0;
  let normalCount = 0;
  let instantCount = 0;
  try {
    const [normalFirst, instantFirst] = await Promise.all([readProtocolRecord(normal.reader), readProtocolRecord(instant.reader)]);
    if (normalFirst?.type !== "header" || instantFirst?.type !== "header") throw new Error("Worker did not emit protocol header");
    normalHeader = normalFirst;
    instantHeader = instantFirst;
    const next = async (reader: NdjsonReader): Promise<OccurrenceRecord | WorkerFooter> => {
      const record = await readProtocolRecord(reader);
      if (record?.type !== "occurrence" && record?.type !== "footer") throw new Error("Worker emitted invalid occurrence stream record");
      return record;
    };
    let left = await next(normal.reader);
    let right = await next(instant.reader);
    while (left.type !== "footer" || right.type !== "footer") {
      if (left.type === "footer") {
        const occurrence = right as OccurrenceRecord;
        extraCount += 1;
        instantCount += 1;
        if (extra.length < DIFFERENCE_EXAMPLE_LIMIT) extra.push({ path: occurrence.path, start: occurrence.start, end: occurrence.end });
        right = await next(instant.reader);
        continue;
      }
      if (right.type === "footer") {
        const occurrence = left as OccurrenceRecord;
        missingCount += 1;
        normalCount += 1;
        if (missing.length < DIFFERENCE_EXAMPLE_LIMIT) missing.push({ path: occurrence.path, start: occurrence.start, end: occurrence.end });
        left = await next(normal.reader);
        continue;
      }
      const comparison = compareOccurrence(left, right);
      if (comparison === 0) {
        normalCount += 1;
        instantCount += 1;
        left = await next(normal.reader);
        right = await next(instant.reader);
      } else if (comparison < 0) {
        normalCount += 1;
        missingCount += 1;
        if (missing.length < DIFFERENCE_EXAMPLE_LIMIT) missing.push({ path: left.path, start: left.start, end: left.end });
        left = await next(normal.reader);
      } else {
        instantCount += 1;
        extraCount += 1;
        if (extra.length < DIFFERENCE_EXAMPLE_LIMIT) extra.push({ path: right.path, start: right.start, end: right.end });
        right = await next(instant.reader);
      }
    }
    normalFooter = left;
    instantFooter = right;
    if (normalFooter.count !== normalCount || instantFooter.count !== instantCount) {
      throw new Error(`Worker footer count mismatch normal=${normalFooter.count}/${normalCount} instant=${instantFooter.count}/${instantCount}`);
    }
  } catch (error) {
    parseError = errorMessage(error);
    await Promise.all([normal.kill(), instant.kill()]);
  }
  const [normalExit, instantExit] = await Promise.all([normal.exit, instant.exit]);
  const timedOut = normalExit.timedOut || instantExit.timedOut;
  const workerWallMs = Math.max(normalExit.wallMs, instantExit.wallMs);
  const indexBytes = Math.max(normalHeader?.indexBytes ?? 0, instantHeader?.indexBytes ?? 0);
  return {
    ...(normalHeader === undefined ? {} : { normalMs: normalHeader.wallMs }),
    ...(instantHeader === undefined ? {} : { instantMs: instantHeader.wallMs }),
    normalOccurrences: normalCount,
    instantOccurrences: instantCount,
    ...(instantHeader?.metadata?.actualBackend === undefined ? {} : { actualBackend: instantHeader.metadata.actualBackend }),
    ...(instantHeader?.metadata?.fallbackReason === undefined ? {} : { fallbackReason: instantHeader.metadata.fallbackReason }),
    missing,
    extra,
    missingCount,
    extraCount,
    ...(normalHeader?.outcome !== "error" ? {} : { normalError: normalHeader.error ?? "normal worker error" }),
    ...(instantHeader?.outcome !== "error" ? {} : { instantError: instantHeader.error ?? "instant worker error" }),
    timedOut,
    indexBytes,
    workerWallMs,
    ...(parseError === undefined && normalExit.code === 0 && instantExit.code === 0 && normalExit.remainingGroupMembers.length === 0 && instantExit.remainingGroupMembers.length === 0
      ? {}
      : { error: parseError ?? `worker exit normal=${normalExit.code}/${normalExit.signal}, instant=${instantExit.code}/${instantExit.signal}; stderr=${normalExit.stderr}${instantExit.stderr}` }),
  };
}

function correctnessStatus(query: BenchmarkQuery, result: Awaited<ReturnType<typeof compareCorrectnessWorkers>>): CorrectnessQueryResult["status"] {
  if (result.error !== undefined || result.timedOut) return "error";
  const normalErrored = result.normalError !== undefined;
  const instantErrored = result.instantError !== undefined;
  if (query.expectedOutcome === "invalid_regex") return normalErrored && instantErrored ? "passed" : "failed";
  if (normalErrored || instantErrored) return "error";
  return result.missingCount === 0 && result.extraCount === 0 ? "passed" : "failed";
}

async function runCorrectnessQuery(supervisor: WorkerSupervisor, prepared: PreparedCorpus, query: BenchmarkQuery): Promise<CorrectnessQueryResult & { workerWallMs: number }> {
  const request = correctnessRequest(query);
  const compared = await compareCorrectnessWorkers(supervisor, prepared.definition.name, prepared.root, request);
  return {
    id: query.id,
    category: query.category,
    ...(query.description === undefined ? {} : { description: query.description }),
    request,
    fingerprint: stableHash({ id: query.id, request }),
    status: correctnessStatus(query, compared),
    ...(query.expectedRoute === undefined ? {} : { expectedRoute: query.expectedRoute }),
    ...(query.expectedOutcome === undefined ? {} : { expectedOutcome: query.expectedOutcome }),
    ...compared,
  };
}

async function runPerformanceQuery(supervisor: WorkerSupervisor, prepared: PreparedCorpus, query: BenchmarkQuery, options: CliOptions): Promise<PerformanceQueryResult> {
  const request = performanceRequest(query);
  const handle = await supervisor.start({
    mode: "performance",
    corpus: prepared.definition.name,
    root: prepared.root,
    request,
    warmups: options.warmups,
    iterations: options.iterations,
  });
  const record = await handle.reader.next();
  const exit = await handle.exit;
  if (exit.timedOut || !isObject(record) || record.type !== "performance-result" || !Array.isArray(record.samples) || exit.code !== 0 || exit.remainingGroupMembers.length > 0) {
    return {
      id: query.id,
      category: query.category,
      ...(query.description === undefined ? {} : { description: query.description }),
      request,
      fingerprint: performanceQueryFingerprint(query),
      status: "error",
      warmups: options.warmups,
      iterations: options.iterations,
      samples: [],
      timedOut: exit.timedOut,
      indexBytes: 0,
      error: `performance worker failed code=${exit.code} signal=${exit.signal}: ${exit.stderr}`,
    };
  }
  const result = record as unknown as PerformanceWorkerResult;
  const samples = result.samples;
  const rg = timingStats(samples.map((sample) => sample.rgMs));
  const instant = timingStats(samples.map((sample) => sample.instantMs));
  const status = samples.length === options.iterations && samples.every((sample) => sample.outputEquivalent) ? "passed" : "failed";
  return {
    id: query.id,
    category: query.category,
    ...(query.description === undefined ? {} : { description: query.description }),
    request,
    fingerprint: performanceQueryFingerprint(query),
    status,
    warmups: options.warmups,
    iterations: options.iterations,
    samples,
    rg,
    instant,
    worstRegressionRatio: rg.p50Ms === 0 ? (instant.p50Ms === 0 ? 1 : Number.POSITIVE_INFINITY) : instant.p50Ms / rg.p50Ms,
    indexBytes: result.indexBytes,
  };
}

function selectQueries(queries: readonly BenchmarkQuery[], options: CliOptions, performanceOnly: boolean): BenchmarkQuery[] {
  let selected = queries.filter((query) => !performanceOnly || query.performance === true);
  if (options.queryFilters.length > 0) {
    selected = selected.filter((query) => options.queryFilters.some((filter) => query.id === filter));
  }
  if (performanceOnly && options.maxPerformanceQueries !== undefined) selected = selected.slice(0, options.maxPerformanceQueries);
  if (selected.length === 0) throw new Error("Query selection is empty");
  return selected;
}

function summarizeCorrectness(phase: CorrectnessPhase): void {
  phase.queryCount = phase.queries.length;
  phase.completedQueries = phase.queries.length;
  phase.failedQueries = phase.queries.filter((query) => query.status === "failed").length;
  phase.errorQueries = phase.queries.filter((query) => query.status === "error").length;
  phase.missingOccurrences = phase.queries.reduce((sum, query) => sum + query.missingCount, 0);
  phase.extraOccurrences = phase.queries.reduce((sum, query) => sum + query.extraCount, 0);
  phase.passed = phase.failedQueries === 0 && phase.errorQueries === 0 && phase.missingOccurrences === 0 && phase.extraOccurrences === 0;
}

function summarizePerformance(phase: PerformancePhase, corpus: RepoName): void {
  const passed = phase.queries.filter((query) => query.status === "passed" && query.instant !== undefined && query.rg !== undefined);
  const worst = [...passed].sort((a, b) => (b.instant?.p50Ms ?? 0) - (a.instant?.p50Ms ?? 0))[0];
  if (worst?.instant !== undefined) {
    phase.worstInstantP50Ms = worst.instant.p50Ms;
    phase.worstInstantQuery = worst.id;
  } else {
    delete phase.worstInstantP50Ms;
    delete phase.worstInstantQuery;
  }
  phase.regressionsOverTenPercent = corpus === "Typical-vite"
    ? passed.filter((query) => (query.worstRegressionRatio ?? Number.POSITIVE_INFINITY) > 1.1).map((query) => query.id)
    : [];
  phase.passed = phase.queries.every((query) => query.status === "passed");
}

function updateGate(artifact: BenchmarkArtifact): void {
  const requested = artifact.lastInvocation.repos.map((repo) => artifact.corpora[repo]).filter((value): value is CorpusResult => value !== undefined);
  const correctness = requested.length > 0 && requested.every((corpus) => corpus.correctness?.completed)
    ? requested.every((corpus) => corpus.correctness?.passed) ? "PASS" : "FAIL"
    : "INCOMPLETE";
  const tail = artifact.corpora.Tail?.performance;
  const tailLatency = tail?.completed
    ? (tail.passed && (tail.worstInstantP50Ms ?? Number.POSITIVE_INFINITY) <= 300 ? "PASS" : "FAIL")
    : "INCOMPLETE";
  const typical = artifact.corpora["Typical-vite"]?.performance;
  const typicalNoHarm = typical?.completed
    ? (typical.passed && typical.regressionsOverTenPercent.length === 0 ? "PASS" : "FAIL")
    : "INCOMPLETE";
  artifact.gate = {
    correctness,
    tailLatency,
    typicalNoHarm,
    resources: artifact.resources.breach === undefined
      && artifact.resources.peakTreeRssBytes <= TREE_RSS_LIMIT_BYTES
      && artifact.resources.maxIndexBytes <= INDEX_LIMIT_BYTES
      && artifact.resources.artifactBytes <= ARTIFACT_LIMIT_BYTES
      && artifact.resources.wallMs <= ROUND_TIMEOUT_MS
      ? "PASS"
      : "FAIL",
    ...(tail?.worstInstantP50Ms === undefined ? {} : { tailWorstInstantP50Ms: tail.worstInstantP50Ms }),
    ...(typical === undefined ? {} : { typicalRegressions: typical.regressionsOverTenPercent }),
  };
}

async function harnessHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of ["benchmarks/run.ts", "package.json"]) {
    const bytes = await readFile(path.join(PROJECT_ROOT, relative));
    hash.update(`${Buffer.byteLength(relative)}:${relative}${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function validateSafetyProof(): Promise<SafetyProof> {
  const proofPath = path.join(PROJECT_ROOT, SAFETY_PROOF_PATH);
  if (!(await exists(proofPath))) throw new Error(`Benchmark safety proof is missing: run Round A2 --safety-probe all first`);
  const proof = JSON.parse(await readFile(proofPath, "utf8")) as SafetyProof;
  if (proof.schemaVersion !== "pi-fast-grep-benchmark-safety-proof/v1" || proof.harnessHash !== await harnessHash() || proof.runtime.platform !== process.platform || proof.runtime.arch !== process.arch || !proof.timeout.passed || !proof.rss.passed || !proof.lifecycle.passed) {
    throw new Error("Benchmark safety proof is stale or incomplete; formal benchmark is refused");
  }
  return proof;
}

async function probeCore(): Promise<PreparedCorpus> {
  return prepareCorpus(CORPORA.Core);
}

async function runTimeoutProbe(runDirectory: string): Promise<SafetyProof["timeout"]> {
  const supervisor = new WorkerSupervisor(runDirectory);
  const handle = await supervisor.start({ mode: "probe-timeout" }, QUERY_TIMEOUT_MS);
  const exit = await handle.exit;
  const quick = await supervisor.start({ mode: "probe-quick" }, 5_000);
  const record = await quick.reader.next();
  const quickExit = await quick.exit;
  const continued = isObject(record) && record.type === "probe-quick" && record.ok === true && quickExit.code === 0;
  return {
    passed: exit.timedOut && exit.signal === "SIGKILL" && continued,
    timeoutMs: QUERY_TIMEOUT_MS,
    observedMs: exit.wallMs,
    killed: exit.signal === "SIGKILL",
    continued,
  };
}

async function runRssProbe(runDirectory: string): Promise<SafetyProof["rss"]> {
  const supervisor = new WorkerSupervisor(runDirectory);
  const evidence = initialResources();
  const watchdog = new ResourceWatchdog(evidence, supervisor, TREE_RSS_LIMIT_BYTES, 30_000, true);
  await watchdog.start();
  const child = await supervisor.start({ mode: "probe-rss" }, 30_000);
  const exit = await child.exit;
  await watchdog.stop();
  return {
    passed: evidence.watchdogTriggered && exit.signal === "SIGKILL" && evidence.peakTreeRssBytes >= TREE_RSS_LIMIT_BYTES,
    limitBytes: TREE_RSS_LIMIT_BYTES,
    triggeredAtBytes: evidence.peakTreeRssBytes,
    killed: exit.signal === "SIGKILL",
  };
}

async function runLifecycleProbe(runDirectory: string): Promise<SafetyProof["lifecycle"]> {
  const prepared = await probeCore();
  const supervisor = new WorkerSupervisor(runDirectory);
  const pids: number[] = [];
  const afterExit: number[] = [];
  const peaks: number[] = [];
  const baselinePids = new Set((await sampleTree()).pids);
  try {
    for (let index = 0; index < 20; index += 1) {
      const request: SearchRequest = { pattern: "FG_RARE_TOKEN", literal: true, hidden: false, context: 0, limit: 10 };
      const baseline = await sampleTree();
      const handle = await supervisor.start({ mode: "correctness", corpus: "Core", root: prepared.root, backend: "normal", request, safetyAllocationBytes: 64 * 1024 * 1024 });
      pids.push(handle.pid);
      let peak = baseline.rssBytes;
      const poll = setInterval(() => {
        void sampleTree().then((sample) => { peak = Math.max(peak, sample.rssBytes); });
      }, 20);
      while (await handle.reader.next() !== undefined) { /* drain bounded protocol */ }
      const exit = await handle.exit;
      clearInterval(poll);
      if (exit.code !== 0 || exit.remainingGroupMembers.length > 0) throw new Error(`Lifecycle worker ${index} failed`);
      peak = Math.max(peak, (await sampleTree()).rssBytes);
      peaks.push(peak);
      afterExit.push((await sampleTree()).rssBytes);
    }
    const remaining = (await sampleTree()).pids.filter((pid) => !baselinePids.has(pid));
    const growth = (afterExit.at(-1) ?? 0) - (afterExit[0] ?? 0);
    const monotonicLargeGrowth = afterExit.slice(1).every((value, index) => value > (afterExit[index] ?? 0) + 1024 * 1024);
    return {
      passed: new Set(pids).size === 20 && growth <= 64 * 1024 * 1024 && !monotonicLargeGrowth && remaining.length === 0,
      workers: 20,
      uniquePids: new Set(pids).size,
      afterExitRssBytes: afterExit,
      workerPeakRssBytes: peaks,
      growthBytes: growth,
      monotonicLargeGrowth,
      remainingDescendants: remaining,
    };
  } finally {
    await supervisor.killAll();
    await prepared.cleanup();
  }
}

async function runSafetyProbes(mode: SafetyProbe): Promise<void> {
  if (process.env[SAFETY_PROBE_ENV] !== "1") {
    throw new Error(`Safety probes require ${SAFETY_PROBE_ENV}=1`);
  }
  const runDirectory = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-safety-probe-"));
  const emptyTimeout: SafetyProof["timeout"] = { passed: false, timeoutMs: QUERY_TIMEOUT_MS, observedMs: 0, killed: false, continued: false };
  const emptyRss: SafetyProof["rss"] = { passed: false, limitBytes: TREE_RSS_LIMIT_BYTES, triggeredAtBytes: 0, killed: false };
  const emptyLifecycle: SafetyProof["lifecycle"] = { passed: false, workers: 0, uniquePids: 0, afterExitRssBytes: [], workerPeakRssBytes: [], growthBytes: 0, monotonicLargeGrowth: false, remainingDescendants: [] };
  try {
    const timeout = mode === "timeout" || mode === "all" ? await runTimeoutProbe(runDirectory) : emptyTimeout;
    const rss = mode === "rss" || mode === "all" ? await runRssProbe(runDirectory) : emptyRss;
    const lifecycle = mode === "lifecycle" || mode === "all" ? await runLifecycleProbe(runDirectory) : emptyLifecycle;
    const proof: SafetyProof = {
      schemaVersion: "pi-fast-grep-benchmark-safety-proof/v1",
      harnessHash: await harnessHash(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      generatedAt: new Date().toISOString(),
      timeout,
      rss,
      lifecycle,
    };
    if (mode === "all" && timeout.passed && rss.passed && lifecycle.passed) {
      const proofPath = path.join(PROJECT_ROOT, SAFETY_PROOF_PATH);
      await mkdir(path.dirname(proofPath), { recursive: true });
      await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o644 });
    }
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    if ((mode === "timeout" && !timeout.passed) || (mode === "rss" && !rss.passed) || (mode === "lifecycle" && !lifecycle.passed) || (mode === "all" && !(timeout.passed && rss.passed && lifecycle.passed))) process.exitCode = 2;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

async function maybeRemoveSafeIndex(prepared: PreparedCorpus, rebuild: boolean): Promise<void> {
  if (!rebuild) return;
  const exact = path.resolve(prepared.root, ".pi", "index", "fast-grep");
  const expectedRoot = path.resolve(prepared.root);
  if (!exact.startsWith(`${expectedRoot}${path.sep}`)) throw new Error("Refusing unsafe index removal");
  await rm(exact, { recursive: true, force: true });
}

async function benchmarkCorpus(
  definition: CorpusDefinition,
  artifact: BenchmarkArtifact,
  options: CliOptions,
  supervisor: WorkerSupervisor,
  watchdog: ResourceWatchdog,
): Promise<void> {
  const prepared = await prepareCorpus(definition);
  try {
    await maybeRemoveSafeIndex(prepared, options.rebuild);
    const matrix = await loadQueries(prepared);
    const previous = artifact.corpora[definition.name];
    const result: CorpusResult = previous?.snapshot === prepared.snapshot && previous.queryCorpusHash === matrix.hash
      ? { ...previous, state: "running", startedAt: new Date().toISOString(), errors: [] }
      : {
          name: definition.name,
          source: definition.source,
          language: definition.language,
          path: prepared.root,
          snapshot: prepared.snapshot,
          trackedFiles: prepared.trackedFiles,
          contentBytes: prepared.contentBytes,
          queryCorpusHash: matrix.hash,
          state: "running",
          startedAt: new Date().toISOString(),
          maxIndexBytes: 0,
          errors: [],
        };
    result.path = prepared.root;
    artifact.corpora[definition.name] = result;
    await atomicWriteArtifact(options.outputPath, artifact);

    const preflight = matrix.queries.find((query) => query.capacityPreflight);
    if (preflight === undefined) throw new Error(`${definition.name}: capacity preflight query missing`);
    const preflightStarted = performance.now();
    const preflightResult = await runCorrectnessQuery(supervisor, prepared, preflight);
    result.maxIndexBytes = Math.max(result.maxIndexBytes, preflightResult.indexBytes);
    artifact.resources.maxIndexBytes = Math.max(artifact.resources.maxIndexBytes, result.maxIndexBytes);
    result.capacityPreflight = {
      queryId: preflight.id,
      passed: preflightResult.status === "passed",
      wallMs: performance.now() - preflightStarted,
      missingCount: preflightResult.missingCount,
      extraCount: preflightResult.extraCount,
      normalOccurrences: preflightResult.normalOccurrences ?? 0,
      instantOccurrences: preflightResult.instantOccurrences ?? 0,
      indexBytes: preflightResult.indexBytes,
      timedOut: preflightResult.timedOut ?? false,
      ...(preflightResult.error === undefined ? {} : { error: preflightResult.error }),
    };
    if (!result.capacityPreflight.passed) throw new Error(`${definition.name}: capacity preflight failed`);
    if (result.maxIndexBytes > INDEX_LIMIT_BYTES) throw new ResourceBreachError(`${definition.name} index ${result.maxIndexBytes} exceeds ${INDEX_LIMIT_BYTES}`);
    watchdog.assertHealthy();
    await atomicWriteArtifact(options.outputPath, artifact);

    if (options.runCorrectness) {
      const selected = selectQueries(matrix.queries, options, false);
      const phase: CorrectnessPhase = {
        querySetHash: correctnessQuerySetHash(selected),
        completed: false,
        passed: false,
        queryCount: selected.length,
        completedQueries: 0,
        failedQueries: 0,
        errorQueries: 0,
        missingOccurrences: 0,
        extraOccurrences: 0,
        queries: [],
      };
      result.correctness = phase;
      for (const query of selected) {
        watchdog.assertHealthy();
        const queryResult = await runCorrectnessQuery(supervisor, prepared, query);
        phase.queries.push(queryResult);
        result.maxIndexBytes = Math.max(result.maxIndexBytes, queryResult.indexBytes);
        artifact.resources.maxIndexBytes = Math.max(artifact.resources.maxIndexBytes, result.maxIndexBytes);
        summarizeCorrectness(phase);
        await atomicWriteArtifact(options.outputPath, artifact);
      }
      phase.completed = true;
      phase.completedAt = new Date().toISOString();
      summarizeCorrectness(phase);
    }

    if (options.runPerformance) {
      if (result.correctness?.completed !== true || result.correctness.passed !== true) {
        throw new Error(`${definition.name}: performance requires passing correctness in the same artifact`);
      }
      const selected = selectQueries(matrix.queries, options, true);
      const phase: PerformancePhase = {
        querySetHash: stableHash(selected.map((query) => ({ id: query.id, request: performanceRequest(query) }))),
        completed: false,
        passed: false,
        warmups: options.warmups,
        iterations: options.iterations,
        percentileMethod: "R-7 linear interpolation",
        queries: [],
        regressionsOverTenPercent: [],
      };
      result.performance = phase;
      for (const query of selected) {
        watchdog.assertHealthy();
        const queryResult = await runPerformanceQuery(supervisor, prepared, query, options);
        phase.queries.push(queryResult);
        result.maxIndexBytes = Math.max(result.maxIndexBytes, queryResult.indexBytes);
        artifact.resources.maxIndexBytes = Math.max(artifact.resources.maxIndexBytes, result.maxIndexBytes);
        summarizePerformance(phase, definition.name);
        await atomicWriteArtifact(options.outputPath, artifact);
      }
      phase.completed = true;
      phase.completedAt = new Date().toISOString();
      summarizePerformance(phase, definition.name);
    }

    if (result.maxIndexBytes > INDEX_LIMIT_BYTES) throw new ResourceBreachError(`${definition.name} index ${result.maxIndexBytes} exceeds ${INDEX_LIMIT_BYTES}`);
    result.state = "completed";
    result.completedAt = new Date().toISOString();
  } catch (error) {
    const result = artifact.corpora[definition.name];
    if (result !== undefined) {
      result.state = "failed";
      result.errors.push(errorMessage(error));
      result.completedAt = new Date().toISOString();
    }
    throw error;
  } finally {
    await prepared.cleanup();
  }
}

async function safeMain(options: CliOptions): Promise<void> {
  if (options.safetyProbe !== undefined) {
    await runSafetyProbes(options.safetyProbe);
    return;
  }
  await validateSafetyProof();
  const implementationHash = computeImplementationHash();
  const artifact = await loadArtifact(options, implementationHash);
  const runDirectory = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-safe-run-"));
  const supervisor = new WorkerSupervisor(runDirectory);
  artifact.resources = initialResources();
  const watchdog = new ResourceWatchdog(artifact.resources, supervisor);
  const started = performance.now();
  let fatal: unknown;
  try {
    await watchdog.start();
    for (const repo of options.repos) {
      assertImplementationHashEvidence(computeImplementationHash(), implementationHash, `implementation before ${repo}`);
      await benchmarkCorpus(CORPORA[repo], artifact, options, supervisor, watchdog);
      assertImplementationHashEvidence(computeImplementationHash(), implementationHash, `implementation after ${repo}`);
    }
  } catch (error) {
    fatal = error;
    artifact.errors.push(errorMessage(error));
    if (error instanceof ResourceBreachError) artifact.resources.breach = error.message;
  } finally {
    await supervisor.killAll();
    await watchdog.stop();
    artifact.resources.wallMs = performance.now() - started;
    artifact.resources.completedAt = new Date().toISOString();
    artifact.resources.queryTimeouts = supervisor.queryTimeouts;
    artifact.resources.childProcessesStarted = supervisor.childrenStarted;
    if (artifact.resources.wallMs > ROUND_TIMEOUT_MS && artifact.resources.breach === undefined) {
      artifact.resources.wallTimeoutTriggered = true;
      artifact.resources.breach = `Round wall clock ${artifact.resources.wallMs} exceeded ${ROUND_TIMEOUT_MS}`;
    }
    updateGate(artifact);
    if (artifact.resources.breach !== undefined) artifact.gate.resources = "FAIL";
    try {
      await atomicWriteArtifact(options.outputPath, artifact);
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${JSON.stringify({ output: options.outputPath, gate: artifact.gate, resources: artifact.resources }, null, 2)}\n`);
  if (fatal !== undefined) throw fatal;
  if (artifact.gate.correctness === "FAIL" || artifact.gate.resources === "FAIL") process.exitCode = 2;
}

async function entrypoint(): Promise<void> {
  const workerAt = process.argv.indexOf(WORKER_FLAG);
  if (workerAt >= 0) {
    const descriptorPath = process.argv[workerAt + 1];
    if (descriptorPath === undefined) throw new Error(`${WORKER_FLAG} requires a descriptor`);
    await workerMain(descriptorPath);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  await safeMain(options);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === RUNNER_PATH) {
  entrypoint().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
