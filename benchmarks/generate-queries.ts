import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { planZoektQuery } from "../src/query-plan.js";
import type { SearchRequest } from "../src/types.js";

type RepoName = "Core" | "Tail" | "Typical-vite";
type ExpectedRoute = "index_preferred" | "fallback_required";
type ExpectedOutcome = "matches" | "no_matches" | "invalid_regex";

interface QueryDefinition {
  id: string;
  category: string;
  description: string;
  request: SearchRequest;
  performanceEligible: boolean;
  capacityPreflight?: boolean;
  expectedOutcome?: ExpectedOutcome;
}

interface MatrixSpec {
  repo: RepoName;
  output: string;
  snapshot: string;
  language: string;
  queries: QueryDefinition[];
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(projectRoot, "benchmarks", "queries");
const tailRoot = path.join(projectRoot, ".bench", "repos", "Tail-synthetic");
const typicalSnapshot = "d62b3360ecebdf11c23e99ffeb4b32e77c9a2ec8";

function query(
  id: string,
  category: string,
  description: string,
  request: SearchRequest,
  options: { preflight?: boolean; outcome?: ExpectedOutcome } = {},
): QueryDefinition {
  return {
    id,
    category,
    description,
    request,
    performanceEligible: true,
    ...(options.preflight ? { capacityPreflight: true } : {}),
    ...(options.outcome === undefined ? {} : { expectedOutcome: options.outcome }),
  };
}

function tailSnapshot(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: tailRoot, encoding: "utf8" }).trim();
  } catch {
    throw new Error("Tail corpus is missing; run npm run benchmark:generate-tail before generating queries");
  }
}

const specs: MatrixSpec[] = [
  {
    repo: "Core",
    output: "v3-core.json",
    snapshot: "deterministic-core-fixture-v1",
    language: "mixed fixture",
    queries: [
      query("literal.rare", "literal", "Rare visible literal.", { pattern: "FG_RARE_TOKEN", literal: true, hidden: false, context: 0, limit: 50 }),
      query("literal.many", "high_frequency_literal", "Highest-cardinality Core token.", { pattern: "FG_MANY_TOKEN", literal: true, hidden: false, context: 0, limit: 50 }, { preflight: true }),
      query("escaped.whitespace", "escaped_regex", "Escaped whitespace regex.", { pattern: "FG_EXTENDED\\s+TOKEN", hidden: false, context: 0, limit: 50 }),
      query("filter.path", "path_glob_filter", "Literal restricted to a subtree.", { pattern: "FG_PATH_TOKEN", literal: true, path: "src/sub", hidden: false, context: 0, limit: 50 }),
      query("filter.glob", "path_glob_filter", "Literal restricted by basename glob.", { pattern: "FG_GLOB_TOKEN", literal: true, glob: "*.ts", hidden: false, context: 0, limit: 50 }),
      query("limit.2", "global_limit", "Global presentation limit over four occurrences.", { pattern: "FG_MANY_TOKEN", literal: true, hidden: false, context: 0, limit: 2 }),
      query("case.insensitive", "case_insensitive", "Explicit ASCII case folding.", { pattern: "mixed_value", literal: true, ignoreCase: true, hidden: false, context: 0, limit: 50 }),
      query("no-match", "no_match", "Bounded deterministic absent token.", { pattern: "FAST_GREP_SAFE_CORE_ABSENT", literal: true, path: "src/main.ts", hidden: false, context: 0, limit: 50 }, { outcome: "no_matches" }),
      query("context.lines", "context", "Context around fixture boundary matches.", { pattern: "CTX_TARGET", literal: true, path: "context.txt", hidden: false, context: 2, limit: 50 }),
      query("multiline.exact", "multiline", "Exact four-line literal.", { pattern: "MULTI_BEGIN\nline alpha\nline beta\nMULTI_END", literal: true, path: "multiline.txt", multiline: true, hidden: false, context: 0, limit: 50 }),
      query("visibility.hidden", "visibility", "Hidden path traversal.", { pattern: "FG_HIDDEN_TOKEN", literal: true, hidden: true, context: 0, limit: 50 }),
      query("ignore.disabled", "ignore", "Ignored path through noIgnore fallback.", { pattern: "FG_IGNORED_TOKEN", literal: true, hidden: false, noIgnore: true, context: 0, limit: 50 }),
    ],
  },
  {
    repo: "Tail",
    output: "v3-tail.json",
    snapshot: tailSnapshot(),
    language: "mixed synthetic",
    queries: [
      query("literal.hot-cr", "high_frequency_literal", "Hot token in 4,000 files including three CRLF files.", { pattern: "TAIL_HOT_TOKEN", literal: true, hidden: false, context: 0, limit: 50 }, { preflight: true }),
      query("escaped.call", "escaped_regex", "Pure escaped-regex literal in 1,200 files.", { pattern: "TAIL_ESCAPED_TOKEN\\(", hidden: false, context: 0, limit: 50 }),
      query("filter.hot-path", "path_glob_filter", "Hot token in one synthetic path partition.", { pattern: "TAIL_HOT_TOKEN", literal: true, path: "src/group-00", hidden: false, context: 0, limit: 50 }),
      query("filter.yaml", "path_glob_filter", "YAML token in 800 basename-glob files.", { pattern: "TAIL_YAML_TOKEN", literal: true, glob: "*.yaml", hidden: false, context: 0, limit: 50 }),
      query("filter.yaml-recursive", "path_glob_filter", "YAML token in a recursive path glob.", { pattern: "TAIL_YAML_TOKEN", literal: true, glob: "configs/**/*.yaml", hidden: false, context: 0, limit: 50 }),
      query("limit.hot-25", "global_limit", "Hot CR-bearing token with presentation limit 25.", { pattern: "TAIL_HOT_TOKEN", literal: true, hidden: false, context: 0, limit: 25 }),
      query("case.hot-insensitive", "case_insensitive", "Case-folded token across 500 files.", { pattern: "tail_case_token", literal: true, ignoreCase: true, hidden: false, context: 0, limit: 50 }),
      query("no-match", "no_match", "Bounded deterministic absent token.", { pattern: "FAST_GREP_SAFE_TAIL_ABSENT", literal: true, path: "README.md", hidden: false, context: 0, limit: 50 }, { outcome: "no_matches" }),
      query("literal.rare", "literal", "Single-file synthetic literal.", { pattern: "TAIL_RARE_TOKEN", literal: true, hidden: false, context: 0, limit: 50 }),
      query("literal.long-line", "literal", "Token at the end of a 64 KiB line.", { pattern: "TAIL_LONG_LINE_TOKEN_0", literal: true, hidden: false, context: 0, limit: 50 }),
      query("binary.after-nul", "binary", "Token only after an early NUL must preserve rg binary behavior.", { pattern: "TAIL_HOT_TOKEN", literal: true, path: "assets", hidden: false, context: 0, limit: 50 }),
      query("literal.yaml", "literal", "Unfiltered YAML token.", { pattern: "TAIL_YAML_TOKEN", literal: true, hidden: false, context: 0, limit: 50 }),
    ],
  },
  {
    repo: "Typical-vite",
    output: "v3-typical-vite.json",
    snapshot: typicalSnapshot,
    language: "TypeScript / typical monorepo",
    queries: [
      query("literal.define-config", "literal", "Vite configuration helper.", { pattern: "defineConfig", literal: true, hidden: false, context: 0, limit: 50 }),
      query("literal.resolved-config", "literal", "Resolved configuration type.", { pattern: "ResolvedConfig", literal: true, hidden: false, context: 0, limit: 50 }),
      query("literal.normalize-path", "literal", "Path normalization helper.", { pattern: "normalizePath", literal: true, hidden: false, context: 0, limit: 50 }),
      query("literal.create-server", "literal", "Development server factory.", { pattern: "createServer", literal: true, hidden: false, context: 0, limit: 50 }),
      query("escaped.import-meta", "escaped_regex", "Literal dot in import.meta.", { pattern: "import\\.meta", hidden: false, context: 0, limit: 50 }),
      query("filter.ts-plugin", "path_glob_filter", "Plugin identifier in TypeScript files.", { pattern: "Plugin", literal: true, glob: "*.ts", hidden: false, context: 0, limit: 50 }),
      query("filter.vite-source", "path_glob_filter", "Path helper under the Vite package source.", { pattern: "normalizePath", literal: true, path: "packages/vite/src", hidden: false, context: 0, limit: 50 }),
      query("filter.tests", "path_glob_filter", "Configuration helper in test files.", { pattern: "defineConfig", literal: true, glob: "**/*.test.ts", hidden: false, context: 0, limit: 50 }),
      query("limit.function-25", "global_limit", "Broad function token with limit 25.", { pattern: "function", literal: true, hidden: false, context: 0, limit: 25 }, { preflight: true }),
      query("case.define-config", "case_insensitive", "Case-insensitive configuration helper.", { pattern: "defineconfig", literal: true, ignoreCase: true, hidden: false, context: 0, limit: 50 }),
      query("no-match", "no_match", "Absent token bounded to the README.", { pattern: "FAST_GREP_SAFE_TYPICAL_ABSENT", literal: true, path: "README.md", hidden: false, context: 0, limit: 50 }, { outcome: "no_matches" }),
      query("literal.server", "high_frequency_literal", "Common server identifier.", { pattern: "server", literal: true, hidden: false, context: 0, limit: 50 }),
    ],
  },
];

mkdirSync(outputRoot, { recursive: true });
for (const spec of specs) {
  const verified = spec.queries.map((definition) => {
    const plan = planZoektQuery(definition.request);
    const expectedRoute: ExpectedRoute = plan.eligible ? "index_preferred" : "fallback_required";
    return {
      id: definition.id,
      category: definition.category,
      description: definition.description,
      request: definition.request,
      expectedRoute,
      performanceEligible: definition.performanceEligible,
      ...(definition.capacityPreflight ? { capacityPreflight: true } : {}),
      expected: { outcome: definition.expectedOutcome ?? "matches" },
    };
  });
  const performanceCount = verified.filter((item) => item.performanceEligible).length;
  if (performanceCount < 10 || performanceCount > 15) throw new Error(`${spec.repo}: invalid performance count ${performanceCount}`);
  if (verified.filter((item) => item.capacityPreflight).length !== 1) throw new Error(`${spec.repo}: exactly one preflight is required`);
  const document = {
    schemaVersion: "fast-grep-benchmark-queries/v2-safe",
    repo: spec.repo,
    snapshot: spec.snapshot,
    language: spec.language,
    description: "Bounded benchmark-v3 corpus. Only rg and Instant are executed.",
    defaults: { hidden: false, context: 0, limit: 50 },
    summary: {
      queryCount: verified.length,
      performanceEligibleCount: performanceCount,
      categoryCounts: Object.fromEntries([...new Set(verified.map((item) => item.category))].sort().map((category) => [category, verified.filter((item) => item.category === category).length])),
    },
    queries: verified,
  };
  writeFileSync(path.join(outputRoot, spec.output), `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${spec.repo}: ${verified.length} correctness / ${performanceCount} performance queries\n`);
}
