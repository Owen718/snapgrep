import { describe, expect, test } from "vitest";
import { searchCandidatesWithBoundedExpansion } from "../src/engine.js";
import type { CandidateResult } from "../src/types.js";

function candidate(overrides: Partial<CandidateResult> = {}): CandidateResult {
  return {
    files: ["initial.ts"],
    indexedCommit: "initial-commit",
    baseVersionState: "consistent",
    filesConsidered: 10_001,
    filesLoaded: 10_001,
    matchCount: 10_001,
    durationMs: 10,
    roundTripMs: 9,
    jsonDecodeMs: 1,
    transportSerializationMs: 3,
    truncated: true,
    ...overrides,
  };
}

describe("bounded Zoekt candidate expansion", () => {
  test("uses a complete expanded result and sums both requests' timings", async () => {
    const controller = new AbortController();
    const initial = candidate({ serverDurationMs: 6 });
    const expanded = candidate({
      files: ["expanded-a.ts", "expanded-b.ts"],
      indexedCommit: "expanded-commit",
      baseVersionState: "no_base_files",
      filesConsidered: 42_000,
      filesLoaded: 40_000,
      matchCount: 25_000,
      durationMs: 21,
      roundTripMs: 20,
      serverDurationMs: 12,
      jsonDecodeMs: 2,
      transportSerializationMs: 5,
      truncated: false,
    });
    const calls: Array<{ maxFiles: number; signal: AbortSignal | undefined }> = [];

    const result = await searchCandidatesWithBoundedExpansion(async (maxFiles, signal) => {
      calls.push({ maxFiles, signal });
      return calls.length === 1 ? initial : expanded;
    }, {
      initialMaxFiles: 10_000,
      maxCandidateFilesConfigured: false,
      signal: controller.signal,
    });

    expect(calls.map(({ maxFiles }) => maxFiles)).toEqual([10_000, 100_000]);
    expect(calls.every(({ signal }) => signal === controller.signal)).toBe(true);
    expect(result).toEqual({
      ...expanded,
      durationMs: 31,
      roundTripMs: 29,
      serverDurationMs: 18,
      jsonDecodeMs: 3,
      transportSerializationMs: 8,
    });
  });

  test("keeps an expanded-but-still-truncated result marked for exact fallback", async () => {
    const initial = candidate();
    const expanded = candidate({
      files: ["expanded-final.ts"],
      indexedCommit: "expanded-final-commit",
      filesConsidered: 100_001,
      filesLoaded: 100_000,
      matchCount: 100_001,
      durationMs: 30,
      roundTripMs: 28,
      serverDurationMs: 20,
      jsonDecodeMs: 4,
      transportSerializationMs: 6,
      truncated: true,
    });
    const limits: number[] = [];

    const result = await searchCandidatesWithBoundedExpansion(async (maxFiles) => {
      limits.push(maxFiles);
      return limits.length === 1 ? initial : expanded;
    }, {
      initialMaxFiles: 10_000,
      maxCandidateFilesConfigured: false,
    });

    expect(limits).toEqual([10_000, 100_000]);
    expect(result).toMatchObject({
      files: expanded.files,
      indexedCommit: expanded.indexedCommit,
      filesConsidered: expanded.filesConsidered,
      filesLoaded: expanded.filesLoaded,
      matchCount: expanded.matchCount,
      truncated: true,
      durationMs: 40,
      roundTripMs: 37,
      jsonDecodeMs: 5,
      transportSerializationMs: 9,
    });
    expect(result).not.toHaveProperty("serverDurationMs");
  });

  test("does not expand an explicitly configured candidate limit", async () => {
    const initial = candidate({ files: ["explicit-limit.ts"] });
    const limits: number[] = [];

    const result = await searchCandidatesWithBoundedExpansion(async (maxFiles) => {
      limits.push(maxFiles);
      return initial;
    }, {
      initialMaxFiles: 37,
      maxCandidateFilesConfigured: true,
    });

    expect(limits).toEqual([37]);
    expect(result).toBe(initial);
  });

  test("does not launch expansion after the shared signal is aborted", async () => {
    const controller = new AbortController();
    const limits: number[] = [];

    await expect(searchCandidatesWithBoundedExpansion(async (maxFiles) => {
      limits.push(maxFiles);
      controller.abort();
      return candidate();
    }, {
      initialMaxFiles: 10_000,
      maxCandidateFilesConfigured: false,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(limits).toEqual([10_000]);
  });
});
