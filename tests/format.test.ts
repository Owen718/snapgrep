import { describe, expect, it } from "vitest";

import { formatSearchResult } from "../src/format.js";
import type { SearchMatch, SearchResult } from "../src/types.js";

function match(overrides: Partial<SearchMatch> = {}): SearchMatch {
  return {
    path: "src/example.ts",
    absolutePath: "/repo/src/example.ts",
    lineNumber: 3,
    lineText: "const needle = true;",
    ranges: [{ absoluteStart: 12, absoluteEnd: 18, lineStart: 6, lineEnd: 12 }],
    before: ["before one", "before two"],
    after: ["after one"],
    ...overrides,
  };
}

function result(matches: SearchMatch[], overrides: Partial<SearchResult["metadata"]> = {}): SearchResult {
  return {
    matches,
    metadata: {
      requestedBackend: "instant",
      actualBackend: "zoekt",
      dirtyFiles: 0,
      realtimeFiles: 0,
      totalMatches: matches.length,
      totalMatchesExact: true,
      displayedMatches: matches.length,
      truncated: false,
      timings: { totalMs: 4.25 },
      ...overrides,
    },
  };
}

describe("formatSearchResult", () => {
  it("renders paths, line numbers, context, and observable backend metadata", () => {
    const formatted = formatSearchResult(result([match()]), { pattern: "needle", context: 2 });
    expect(formatted.text).toContain("src/example.ts-1- before one");
    expect(formatted.text).toContain("src/example.ts:3: const needle = true;");
    expect(formatted.text).toContain("backend=zoekt");
    expect(formatted.text).toContain("matches=1/1");
    expect(formatted.details.matches).toHaveLength(1);
  });

  it("states exact and lower-bound truncation totals without silently presenting completeness", () => {
    const exact = formatSearchResult(
      result([match()], { totalMatches: 20, displayedMatches: 1, truncated: true }),
      { pattern: "needle", limit: 1 },
    );
    expect(exact.text).toContain("Showing 1 of 20 matches (limit 1)");
    expect(exact.details.matchLimitReached).toBe(1);

    const lowerBound = formatSearchResult(
      result([match()], {
        totalMatches: 20,
        totalMatchesExact: false,
        displayedMatches: 1,
        truncated: true,
      }),
      { pattern: "needle", limit: 1 },
    );
    expect(lowerBound.text).toContain("Showing 1 of at least 20 matches");
    expect(lowerBound.text).toContain("matches=1/>=20");
  });

  it("offers one rg self-check only for an indexed empty result", () => {
    const indexed = formatSearchResult(result([]), { pattern: "missing" });
    expect(indexed.text).toContain("No matches found");
    expect(indexed.text).toContain("verify once with `rg --no-config`");

    const alreadyVerified = formatSearchResult(
      result([], { actualBackend: "rg_fallback" }),
      { pattern: "missing" },
    );
    expect(alreadyVerified.text).toContain("No matches found");
    expect(alreadyVerified.text).not.toContain("rg --no-config");
  });

  it("marks both per-line and whole-output truncation", () => {
    const many = Array.from({ length: 140 }, (_, index) => match({
      path: `src/file-${String(index).padStart(3, "0")}.ts`,
      absolutePath: `/repo/src/file-${index}.ts`,
      lineNumber: 1,
      lineText: "x".repeat(700),
      before: [],
      after: [],
      ranges: [{ absoluteStart: 0, absoluteEnd: 1, lineStart: 0, lineEnd: 1 }],
    }));
    const formatted = formatSearchResult(result(many), { pattern: "x", limit: null });
    expect(formatted.details.linesTruncated).toBe(true);
    expect(formatted.details.outputTruncated).toBe(true);
    expect(Buffer.byteLength(formatted.text)).toBeLessThanOrEqual(50 * 1024 + 256);
    expect(formatted.text).toContain("Output truncated at 50 KiB");
  });
});
