import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KernelMutationFeed,
  OptInKernelEngine,
} from "../src/kernel-engine.ts";
import { loadKernelBinding } from "../src/kernel-binding.ts";
import { runCommand, type CommandResult } from "../src/process.ts";
import { runRipgrep } from "../src/rg.ts";
import type { SearchRequest } from "../src/types.ts";

const nativeEnabled = process.env.PI_FAST_GREP_NATIVE_TEST === "1";
type CaptureSourceProbe = {
  captureSource(signal?: AbortSignal): Promise<unknown>;
};
type StartProbe = CaptureSourceProbe & {
  captureSourceMetadata(signal?: AbortSignal): Promise<unknown>;
  captureFusedSourceMetadata(): Promise<unknown>;
  captureSourceContents(...args: unknown[]): Promise<unknown>;
  readManifest(): Promise<unknown>;
};
type FusedMetadataProbe = StartProbe & {
  canonicalRoot?: string;
  listUniverse(signal?: AbortSignal): Promise<string[]>;
  readFusedGitHead(environment: NodeJS.ProcessEnv): Promise<CommandResult>;
  readFusedGitStatus(environment: NodeJS.ProcessEnv): Promise<CommandResult>;
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commandResult(
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return {
    code: 0,
    stdout: "fixture-head\n",
    stderr: "",
    durationMs: 0,
    ...overrides,
  };
}

function utf16WithBom(text: string, endian: "le" | "be"): Buffer {
  const body = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    if (endian === "le") body.writeUInt16LE(text.charCodeAt(index), index * 2);
    else body.writeUInt16BE(text.charCodeAt(index), index * 2);
  }
  return Buffer.concat([
    Buffer.from(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]),
    body,
  ]);
}

describe.skipIf(!nativeEnabled)("opt-in kernel engine", () => {
  let fixture: string;
  let outside: string;
  let addonPath: string;

  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(path.join(tmpdir(), "pi-fast-grep-kernel-engine-")));
    outside = `${fixture}-outside.txt`;
    await writeFile(outside, "before\r\nneedle EXTERNAL SECRET\r\nafter\r\n");
    await mkdir(path.join(fixture, "src"), { recursive: true });
    await writeFile(path.join(fixture, ".gitignore"), ".pi/index/\n");
    await writeFile(path.join(fixture, "A.txt"), "before\r\nneedle needle\r\nafter\r\n");
    await writeFile(path.join(fixture, "src", "\u{e000}.txt"), "needle private\n");
    await writeFile(path.join(fixture, "src", "😀.txt"), "needle supplementary\n");
    await writeFile(path.join(fixture, "src", "binary.bin"), "binary-hit\0tail");
    await writeFile(
      path.join(fixture, "src", "after-nul-regex.bin"),
      "\0post-nul-regex-hit\nbinary-only-after-hit",
    );
    await writeFile(
      path.join(fixture, "src", "post-nul-regex.txt"),
      "post-nul-regex-hit\n",
    );
    await writeFile(path.join(fixture, "src", "bare-cr.txt"), "left\rbare-cr-hit\rright");
    await runCommand("git", ["init", "-q"], { cwd: fixture });
    await runCommand("git", ["config", "user.email", "kernel@example.invalid"], { cwd: fixture });
    await runCommand("git", ["config", "user.name", "Kernel Test"], { cwd: fixture });
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "fixture"], { cwd: fixture });

    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    addonPath = path.join(bindingDirectory, addons[0] as string);
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  it("matches the rg product boundary, reuses clean mmap, and fails closed", async () => {
    const first = new OptInKernelEngine({ root: fixture, addonPath });
    const firstStartCapture = vi.spyOn(
      first as unknown as CaptureSourceProbe,
      "captureSource",
    );
    const firstStart = await first.start();
    expect(firstStart.reusedPersistentGeneration).toBe(false);
    expect(firstStart.buildStats).toBeDefined();
    expect(firstStartCapture).toHaveBeenCalledTimes(2);
    firstStartCapture.mockRestore();

    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 1,
      limit: null,
    };
    const verifiedCapture = vi.spyOn(
      first as unknown as CaptureSourceProbe,
      "captureSource",
    );
    const kernel = await first.search(request);
    expect(verifiedCapture).toHaveBeenCalledTimes(2);
    verifiedCapture.mockRestore();
    const normal = await runRipgrep(fixture, request);
    expect(kernel.matches).toEqual(normal.matches);
    expect(kernel.metadata).toMatchObject({
      actualBackend: "kernel",
      kernelFreshnessMode: "verified",
      totalMatches: normal.metadata.totalMatches,
      displayedMatches: normal.metadata.displayedMatches,
      truncated: false,
      totalMatchesExact: true,
    });
    expect(kernel.metadata.kernelOccurrences).toBe(4);

    const cappedRequest = { ...request, limit: 1 };
    const cappedKernel = await first.search(cappedRequest);
    const cappedNormal = await runRipgrep(fixture, cappedRequest);
    expect(cappedKernel.matches).toEqual(cappedNormal.matches);
    expect(cappedKernel.metadata.totalMatches).toBe(normal.metadata.totalMatches);
    expect(cappedKernel.metadata.truncated).toBe(true);
    const defaultContextRequest: SearchRequest = {
      pattern: "needle",
      literal: true,
      limit: null,
    };
    expect((await first.search(defaultContextRequest)).matches).toEqual(
      (await runRipgrep(fixture, defaultContextRequest)).matches,
    );
    const zeroRequest: SearchRequest = {
      pattern: "needle",
      literal: true,
      limit: 0,
    };
    expect((await first.search(zeroRequest)).matches).toEqual(
      (await runRipgrep(fixture, zeroRequest)).matches,
    );
    first.close();

    const second = new OptInKernelEngine({ root: fixture, addonPath });
    const secondStart = await second.start();
    expect(secondStart.reusedPersistentGeneration).toBe(true);
    expect(secondStart.buildStats).toBeUndefined();
    expect((await second.search(request)).matches).toEqual(normal.matches);

    const binary = await second.search({
      pattern: "binary-hit",
      literal: true,
      context: 0,
      limit: null,
    });
    expect(binary.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_binary_match",
    });
    expect(binary.matches).toEqual(
      (await runRipgrep(fixture, {
        pattern: "binary-hit",
        literal: true,
        context: 0,
        limit: null,
      })).matches,
    );

    const regexRequest: SearchRequest = {
      pattern: "need.*",
      hidden: false,
      limit: null,
    };
    const regex = await second.search(regexRequest);
    expect(regex.metadata).toMatchObject({
      actualBackend: "kernel",
      totalMatchesExact: true,
    });
    expect(regex.matches).toEqual((await runRipgrep(fixture, regexRequest)).matches);
    expect(regex.metadata.kernelVerifiedFiles).toBeGreaterThan(0);

    const noMandatory = await second.search({
      pattern: "foo|bar",
      hidden: false,
      limit: null,
    });
    expect(noMandatory.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_regex_no_mandatory_trigram",
    });

    const emptyCandidates = await second.search({
      pattern: "absent.*token",
      hidden: false,
      limit: null,
    });
    expect(emptyCandidates.metadata).toMatchObject({
      actualBackend: "kernel",
      totalMatches: 0,
      totalMatchesExact: true,
      kernelVerifiedFiles: 0,
    });
    expect(emptyCandidates.matches).toEqual([]);

    const binaryRegexRequest: SearchRequest = {
      pattern: "binary-(?:hit|miss)",
      hidden: false,
      limit: null,
    };
    const binaryRegex = await second.search(binaryRegexRequest);
    expect(binaryRegex.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_binary_candidate",
    });
    expect(binaryRegex.matches).toEqual(
      (await runRipgrep(fixture, binaryRegexRequest)).matches,
    );

    const prunedBinaryRegexRequest: SearchRequest = {
      pattern: "post-nul-regex-(?:hit|miss)",
      hidden: false,
      limit: null,
    };
    const prunedBinaryRegex = await second.search(prunedBinaryRegexRequest);
    expect(prunedBinaryRegex.metadata).toMatchObject({
      actualBackend: "kernel",
      kernelVerifiedFiles: 1,
    });
    expect(prunedBinaryRegex.matches).toEqual(
      (await runRipgrep(fixture, prunedBinaryRegexRequest)).matches,
    );
    expect(prunedBinaryRegex.matches.map((match) => match.path)).toEqual([
      "src/post-nul-regex.txt",
    ]);

    const emptyAfterPruningRequest: SearchRequest = {
      pattern: "binary-only-after-(?:hit|miss)",
      hidden: false,
      limit: null,
    };
    const emptyAfterPruning = await second.search(emptyAfterPruningRequest);
    expect(emptyAfterPruning.metadata).toMatchObject({
      actualBackend: "kernel",
      totalMatches: 0,
      totalMatchesExact: true,
      kernelVerifiedFiles: 0,
    });
    expect(emptyAfterPruning.matches).toEqual(
      (await runRipgrep(fixture, emptyAfterPruningRequest)).matches,
    );

    await expect(
      second.search({
        pattern: "(?<=needle) suffix",
        hidden: false,
        limit: null,
      }),
    ).rejects.toThrow(/regex|look-around|lookbehind|error/iu);
    await expect(
      second.search({
        pattern: "needle",
        literal: true,
        limit: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("limit must be a finite number or null");

    const bareCrRequest: SearchRequest = {
      pattern: "bare-cr-hit",
      literal: true,
      context: 0,
      limit: null,
    };
    const bareCr = await second.search(bareCrRequest);
    expect(bareCr.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "PFG_UNSUPPORTED_LITERAL",
    });
    expect(bareCr.matches).toEqual((await runRipgrep(fixture, bareCrRequest)).matches);

    second.close();
    await writeFile(second.indexPath, "corrupt generation");
    const third = new OptInKernelEngine({ root: fixture, addonPath });
    const thirdStart = await third.start();
    expect(thirdStart.reusedPersistentGeneration).toBe(false);

    await writeFile(path.join(fixture, "src", "new.txt"), "needle new\n");
    const invalidated = await third.search(request);
    expect(invalidated.metadata.actualBackend).toBe("rg_fallback");
    expect(["kernel_workspace_event", "kernel_snapshot_changed"]).toContain(
      invalidated.metadata.fallbackReason,
    );
    expect(invalidated.matches.map((match) => match.path)).toContain("src/new.txt");
    third.close();

    const dirty = new OptInKernelEngine({ root: fixture, addonPath });
    await expect(dirty.start()).rejects.toThrow("clean Git snapshot");
    dirty.close();

    expect(
      () =>
        new OptInKernelEngine({
          root: fixture,
          addonPath,
          indexPath: path.join(fixture, "unsafe-index.pfg"),
        }),
    ).toThrow("permanently excluded .pi/index");
  });

  it("applies a validated literal path root before verification and blocker classification", async () => {
    await mkdir(path.join(fixture, "scope"), { recursive: true });
    await mkdir(path.join(fixture, "outside-scope"), { recursive: true });
    await writeFile(path.join(fixture, "scope", "visible.txt"), "needle scoped\n");
    await writeFile(path.join(fixture, "outside-scope", "binary.bin"), "needle\0tail");
    await writeFile(
      path.join(fixture, "outside-scope", "unsafe-bom.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("needle\0tail\n"),
      ]),
    );
    await writeFile(
      path.join(fixture, "outside-scope", "utf16.txt"),
      utf16WithBom("needle outside UTF-16\n", "le"),
    );
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add path filter fixtures"], { cwd: fixture });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      for (const requestPath of ["scope", "scope/visible.txt", "A.txt"]) {
        const request: SearchRequest = {
          pattern: "needle",
          literal: true,
          path: requestPath,
          hidden: false,
          context: 0,
          limit: null,
        };
        const result = await engine.search(request);
        expect(result.metadata.actualBackend).toBe("kernel");
        expect(result.matches).toEqual((await runRipgrep(fixture, request)).matches);
        expect(result.matches.every((match) =>
          requestPath === "A.txt" ? match.path === requestPath : match.path.startsWith("scope/"),
        )).toBe(true);
      }

      const blockedRequest: SearchRequest = {
        pattern: "needle",
        literal: true,
        path: "outside-scope",
        hidden: false,
        limit: null,
      };
      const blocked = await engine.search(blockedRequest);
      expect(blocked.metadata.actualBackend).toBe("rg_fallback");
      expect(blocked.matches).toEqual((await runRipgrep(fixture, blockedRequest)).matches);

      const regexPath = await engine.search({
        pattern: "need.*",
        path: "scope",
        hidden: false,
        limit: null,
      });
      expect(regexPath.metadata).toMatchObject({
        actualBackend: "rg_fallback",
        fallbackReason: "kernel_path_filter_unsupported",
      });
    } finally {
      engine.close();
    }
  });

  it("matches rg for a literal path targeting one matching file", async () => {
    const singlePath = path.join(fixture, "src", "single-match.txt");
    await writeFile(
      singlePath,
      "before one\nneedle first\nbetween\nneedle needle second\nafter\n",
    );
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add single-file path fixture"], {
      cwd: fixture,
    });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      const unlimitedRequest: SearchRequest = {
        pattern: "needle",
        literal: true,
        path: "src/single-match.txt",
        context: 1,
        limit: null,
      };
      const unlimited = await engine.search(unlimitedRequest);
      const unlimitedRg = await runRipgrep(fixture, unlimitedRequest);
      expect(unlimited.metadata).toMatchObject({
        actualBackend: "kernel",
        totalMatches: 2,
        displayedMatches: 2,
        truncated: false,
        totalMatchesExact: true,
        kernelVerifiedFiles: 1,
        kernelOccurrences: 3,
      });
      expect(unlimited.matches).toEqual(unlimitedRg.matches);
      expect(unlimited.matches.map((match) => match.ranges)).toEqual([
        [{ absoluteStart: 11, absoluteEnd: 17, lineStart: 0, lineEnd: 6 }],
        [
          { absoluteStart: 32, absoluteEnd: 38, lineStart: 0, lineEnd: 6 },
          { absoluteStart: 39, absoluteEnd: 45, lineStart: 7, lineEnd: 13 },
        ],
      ]);
      expect(unlimited.matches.map((match) => ({
        before: match.before,
        after: match.after,
      }))).toEqual(unlimitedRg.matches.map((match) => ({
        before: match.before,
        after: match.after,
      })));

      const limitedRequest = { ...unlimitedRequest, limit: 1 };
      const limited = await engine.search(limitedRequest);
      const limitedRg = await runRipgrep(fixture, limitedRequest);
      expect(limited.metadata).toMatchObject({
        actualBackend: "kernel",
        totalMatches: 2,
        displayedMatches: 1,
        truncated: true,
        totalMatchesExact: true,
        kernelVerifiedFiles: 1,
        kernelOccurrences: 3,
      });
      expect(limited.matches).toEqual(limitedRg.matches);
      expect(limited.matches).toEqual(unlimited.matches.slice(0, 1));
    } finally {
      engine.close();
    }
  });

  it("does not include matching directories that only share the path prefix", async () => {
    for (const directory of ["group-00", "group-000", "group-00-extra"]) {
      await mkdir(path.join(fixture, "src", directory), { recursive: true });
      await writeFile(
        path.join(fixture, "src", directory, "match.txt"),
        `needle ${directory}\n`,
      );
    }
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add path-prefix fixtures"], {
      cwd: fixture,
    });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      const request: SearchRequest = {
        pattern: "needle",
        literal: true,
        path: "src/group-00",
        hidden: false,
        context: 0,
        limit: null,
      };
      const result = await engine.search(request);
      const normal = await runRipgrep(fixture, request);
      expect(result.metadata).toMatchObject({
        actualBackend: "kernel",
        totalMatches: 1,
        displayedMatches: 1,
        kernelVerifiedFiles: 1,
        kernelOccurrences: 1,
      });
      expect(result.matches).toEqual(normal.matches);
      expect(result.matches.map((match) => match.path)).toEqual([
        "src/group-00/match.txt",
      ]);
      expect(result.matches.some((match) =>
        match.path.startsWith("src/group-000/")
        || match.path.startsWith("src/group-00-extra/"),
      )).toBe(false);
    } finally {
      engine.close();
    }
  });

  it("matches the supported literal glob subset exactly and rejects unsupported syntax", async () => {
    const globFiles = [
      ["configs/a.yaml", "needle direct yaml\n"],
      ["configs/sub/a.yaml", "needle nested yaml\n"],
      ["deep/nested/a.yaml", "needle deep yaml\n"],
      ["a.test.ts", "needle root test\n"],
      ["tests/nested/b.test.ts", "needle nested test\n"],
    ] as const;
    for (const [relativePath, content] of globFiles) {
      await mkdir(path.dirname(path.join(fixture, relativePath)), { recursive: true });
      await writeFile(path.join(fixture, relativePath), content);
    }
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add glob fixtures"], { cwd: fixture });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      const cases = [
        {
          glob: "configs/**/*.yaml",
          expectedPaths: ["configs/a.yaml", "configs/sub/a.yaml"],
          candidateFiles: 2,
        },
        {
          glob: "configs/*.yaml",
          expectedPaths: ["configs/a.yaml"],
          candidateFiles: 1,
        },
        {
          glob: "*.yaml",
          expectedPaths: [
            "configs/a.yaml",
            "configs/sub/a.yaml",
            "deep/nested/a.yaml",
          ],
          candidateFiles: 3,
        },
        {
          glob: "**/*.test.ts",
          expectedPaths: ["a.test.ts", "tests/nested/b.test.ts"],
          candidateFiles: 2,
        },
      ] as const;
      for (const testCase of cases) {
        const request: SearchRequest = {
          pattern: "needle",
          literal: true,
          glob: testCase.glob,
          hidden: false,
          context: 0,
          limit: null,
        };
        const result = await engine.search(request);
        const normal = await runRipgrep(fixture, request);
        expect(result.metadata).toMatchObject({
          actualBackend: "kernel",
          kernelCandidateFiles: testCase.candidateFiles,
          kernelVerifiedFiles: testCase.candidateFiles,
          totalMatches: testCase.expectedPaths.length,
          displayedMatches: testCase.expectedPaths.length,
          totalMatchesExact: true,
          truncated: false,
        });
        expect(result.matches).toEqual(normal.matches);
        expect(result.matches.map((match) => match.path)).toEqual(testCase.expectedPaths);
      }

      const unsupportedRequest: SearchRequest = {
        pattern: "needle",
        literal: true,
        glob: "!*.yaml",
        hidden: false,
        context: 0,
        limit: null,
      };
      const unsupported = await engine.search(unsupportedRequest);
      expect(unsupported.metadata).toMatchObject({
        actualBackend: "rg_fallback",
        fallbackReason: "kernel_glob_unsupported",
      });
      expect(unsupported.matches).toEqual(
        (await runRipgrep(fixture, unsupportedRequest)).matches,
      );

      const regexGlob = await engine.search({
        pattern: "need.*",
        glob: "*.yaml",
        hidden: false,
        context: 0,
        limit: null,
      });
      expect(regexGlob.metadata).toMatchObject({
        actualBackend: "rg_fallback",
        fallbackReason: "kernel_glob_unsupported",
      });
    } finally {
      engine.close();
    }
  });

  it("matches ASCII case-folded literals at original offsets and fails closed for Unicode folds", async () => {
    const caseFiles = [
      ["case/variants.txt", Buffer.from("token TOKEN Token ToKeN\n")],
      ["case/cross.txt", Buffer.from("before\r\ndefineConfig DEFINEconfig\r\nafter\r\n")],
      ["case/bom.txt", Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("DeFiNeCoNfIg\n"),
      ])],
      ["case/long.txt", Buffer.from(`${"x".repeat((64 * 1024) - 2)}defineConfig\n`)],
      ["case/include.ts", Buffer.from("defineConfig\n")],
      ["case/exclude.txt", Buffer.from("defineConfig\n")],
      ["case/unicode-kelvin.txt", Buffer.from("Kelvin\n")],
    ] as const;
    for (const [relativePath, content] of caseFiles) {
      await mkdir(path.dirname(path.join(fixture, relativePath)), { recursive: true });
      await writeFile(path.join(fixture, relativePath), content);
    }
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add case-fold fixtures"], { cwd: fixture });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      const variantsRequest: SearchRequest = {
        pattern: "token",
        literal: true,
        ignoreCase: true,
        path: "case/variants.txt",
        hidden: false,
        context: 0,
        limit: null,
      };
      const variants = await engine.search(variantsRequest);
      const variantsRg = await runRipgrep(fixture, variantsRequest);
      expect(variants.matches).toEqual(variantsRg.matches);
      expect(variants.metadata).toMatchObject({
        actualBackend: "kernel",
        totalMatches: 1,
        displayedMatches: 1,
        kernelCandidateFiles: 1,
        kernelVerifiedFiles: 1,
        kernelOccurrences: 4,
      });
      expect(variants.matches[0]?.ranges).toEqual([
        { absoluteStart: 0, absoluteEnd: 5, lineStart: 0, lineEnd: 5 },
        { absoluteStart: 6, absoluteEnd: 11, lineStart: 6, lineEnd: 11 },
        { absoluteStart: 12, absoluteEnd: 17, lineStart: 12, lineEnd: 17 },
        { absoluteStart: 18, absoluteEnd: 23, lineStart: 18, lineEnd: 23 },
      ]);

      const crossBoundaryRequest: SearchRequest = {
        pattern: "defineconfig",
        literal: true,
        ignoreCase: true,
        path: "case",
        hidden: false,
        context: 1,
        limit: null,
      };
      const crossBoundary = await engine.search(crossBoundaryRequest);
      const crossBoundaryRg = await runRipgrep(fixture, crossBoundaryRequest);
      expect(crossBoundary.metadata.actualBackend).toBe("kernel");
      expect(crossBoundary.matches).toEqual(crossBoundaryRg.matches);
      expect(
        crossBoundary.matches
          .find((match) => match.path === "case/cross.txt")
          ?.ranges.map((range) => [range.absoluteStart, range.absoluteEnd]),
      ).toEqual([[8, 20], [21, 33]]);
      expect(
        crossBoundary.matches
          .find((match) => match.path === "case/long.txt")
          ?.ranges[0]?.absoluteStart,
      ).toBe((64 * 1024) - 2);
      expect(
        crossBoundary.matches
          .find((match) => match.path === "case/bom.txt")
          ?.ranges[0]?.absoluteStart,
      ).toBe(0);

      const globRequest: SearchRequest = {
        pattern: "defineconfig",
        literal: true,
        ignoreCase: true,
        glob: "*.ts",
        hidden: false,
        context: 0,
        limit: null,
      };
      const glob = await engine.search(globRequest);
      expect(glob.metadata.actualBackend).toBe("kernel");
      expect(glob.matches).toEqual((await runRipgrep(fixture, globRequest)).matches);
      expect(glob.matches.map((match) => match.path)).toEqual(["case/include.ts"]);

      const nonAsciiPatternRequest: SearchRequest = {
        pattern: "Kelvin",
        literal: true,
        ignoreCase: true,
        hidden: false,
        context: 0,
        limit: null,
      };
      const nonAsciiPattern = await engine.search(nonAsciiPatternRequest);
      expect(nonAsciiPattern.metadata).toMatchObject({
        actualBackend: "rg_fallback",
        fallbackReason: "kernel_case_fold_non_ascii_pattern",
      });
      expect(nonAsciiPattern.matches).toEqual(
        (await runRipgrep(fixture, nonAsciiPatternRequest)).matches,
      );

      const unicodeFoldRequest: SearchRequest = {
        pattern: "kelvin",
        literal: true,
        ignoreCase: true,
        hidden: false,
        context: 0,
        limit: null,
      };
      const unicodeFold = await engine.search(unicodeFoldRequest);
      expect(unicodeFold.metadata).toMatchObject({
        actualBackend: "rg_fallback",
        fallbackReason: "kernel_unicode_case_fold",
      });
      expect(unicodeFold.matches).toEqual(
        (await runRipgrep(fixture, unicodeFoldRequest)).matches,
      );
    } finally {
      engine.close();
    }
  });

  it("applies hidden=false before literal verification and fallback classification", async () => {
    await mkdir(path.join(fixture, ".hidden"), { recursive: true });
    await writeFile(path.join(fixture, ".hidden", "text.txt"), "needle hidden\n");
    await writeFile(
      path.join(fixture, ".hidden", "binary.bin"),
      "hidden-binary-token\0tail",
    );
    await writeFile(
      path.join(fixture, ".hidden", "unsafe-bom.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("hidden-unsafe-token\0tail\n"),
      ]),
    );
    await writeFile(
      path.join(fixture, ".hidden", "utf16.txt"),
      utf16WithBom("needle hidden UTF-16\n", "le"),
    );
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add hidden fixtures"], { cwd: fixture });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      for (const pattern of ["needle", "hidden-binary-token"]) {
        const request: SearchRequest = {
          pattern,
          literal: true,
          hidden: false,
          context: 0,
          limit: null,
        };
        const result = await engine.search(request);
        expect(result.metadata.actualBackend).toBe("kernel");
        expect(result.matches).toEqual((await runRipgrep(fixture, request)).matches);
        expect(result.matches.every((match) => !match.path.startsWith("."))).toBe(true);
      }
    } finally {
      engine.close();
    }
  });

  it("uses exact rg verification for UTF BOM literal and regex candidates", async () => {
    await writeFile(
      path.join(fixture, "src", "utf8-bom.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("prefix needle suffix\n"),
      ]),
    );
    await writeFile(
      path.join(fixture, "src", "utf16le.txt"),
      utf16WithBom("prefix needle suffix\n", "le"),
    );
    await writeFile(
      path.join(fixture, "src", "utf16be.txt"),
      utf16WithBom("prefix needle suffix\n", "be"),
    );
    await writeFile(
      path.join(fixture, "src", "utf16-malformed.txt"),
      Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0xd8]),
        utf16WithBom(" needle suffix\n", "le").subarray(2),
      ]),
    );
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add BOM fixtures"], { cwd: fixture });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      const literalRequest: SearchRequest = {
        pattern: "needle",
        literal: true,
        context: 1,
        limit: null,
      };
      const literal = await engine.search(literalRequest);
      const normalLiteral = await runRipgrep(fixture, literalRequest);
      expect(literal.metadata.actualBackend).toBe("kernel");
      expect(literal.metadata.timings.verifyMs).toBeGreaterThanOrEqual(0);
      expect(literal.matches).toEqual(normalLiteral.matches);

      const regexRequest: SearchRequest = {
        pattern: "need(?:le)+",
        hidden: false,
        context: 1,
        limit: null,
      };
      const regex = await engine.search(regexRequest);
      const normalRegex = await runRipgrep(fixture, regexRequest);
      expect(regex.metadata.actualBackend).toBe("kernel");
      expect(regex.metadata.timings.verifyMs).toBeGreaterThanOrEqual(0);
      expect(regex.matches).toEqual(normalRegex.matches);
    } finally {
      engine.close();
    }
  });

  it("falls back to tree rg when a BOM-decoded stream contains NUL", async () => {
    await writeFile(
      path.join(fixture, "src", "utf16-decoded-nul.txt"),
      utf16WithBom("needle\0tail\n", "le"),
    );
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "add unsafe BOM fixture"], {
      cwd: fixture,
    });

    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    try {
      const requests = [
        {
          pattern: "needle",
          literal: true,
          limit: null,
        },
        {
          pattern: "need.*",
          hidden: false,
          limit: null,
        },
      ] satisfies SearchRequest[];
      for (const request of requests) {
        const result = await engine.search(request);
        expect(result.metadata).toMatchObject({
          actualBackend: "rg_fallback",
          fallbackReason: "kernel_transcoded_binary",
        });
        expect(result.matches).toEqual((await runRipgrep(fixture, request)).matches);
      }
    } finally {
      engine.close();
    }
  });

  it("never materializes a tracked file replaced by an external symlink", async () => {
    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    await engine.start();
    await rm(path.join(fixture, "A.txt"));
    await symlink(outside, path.join(fixture, "A.txt"));

    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    const result = await engine.search(request);
    expect(result.metadata.actualBackend).toBe("rg_fallback");
    expect(result.matches.some((match) => match.path === "A.txt")).toBe(false);
    expect(result.matches.some((match) => match.lineText.includes("EXTERNAL SECRET"))).toBe(false);
    engine.close();
  });

  it("uses an explicit pre-mutation feed as an O(1) permanent generation fence", async () => {
    const feed = new KernelMutationFeed();
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: feed,
    });
    await engine.start();
    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    const agentLoopCapture = vi.spyOn(
      engine as unknown as CaptureSourceProbe,
      "captureSource",
    );
    const initial = await engine.search(request);
    expect(initial.metadata).toMatchObject({
      actualBackend: "kernel",
      kernelFreshnessMode: "agent_loop_serialized_v1",
    });
    expect(initial.matches).toEqual((await runRipgrep(fixture, request)).matches);
    expect(agentLoopCapture).not.toHaveBeenCalled();

    const inFlight = engine.search(request);
    queueMicrotask(() => feed.mark("kernel_tool_call_write"));
    const raced = await inFlight;
    expect(raced.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_tool_call_write",
      kernelFreshnessMode: "agent_loop_serialized_v1",
    });
    expect(raced.matches).toEqual(
      (await runRipgrep(fixture, request)).matches,
    );

    await writeFile(path.join(fixture, "src", "new.txt"), "needle new\n");
    feed.mark("later_reason_must_not_replace_first");
    const afterMutation = await engine.search(request);
    expect(afterMutation.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_tool_call_write",
    });
    expect(afterMutation.matches.map((match) => match.path)).toContain("src/new.txt");
    await rm(path.join(fixture, "A.txt"));
    await writeFile(path.join(fixture, "src", "new.txt"), "replacement without token\n");
    feed.mark("kernel_tool_call_unknown_mutator");
    const afterDeleteAndModify = await engine.search(request);
    expect(afterDeleteAndModify.matches).toEqual(
      (await runRipgrep(fixture, request)).matches,
    );
    expect(afterDeleteAndModify.matches.map((match) => match.path)).not.toContain("A.txt");
    expect(afterDeleteAndModify.matches.map((match) => match.path)).not.toContain("src/new.txt");
    expect(agentLoopCapture).not.toHaveBeenCalled();
    agentLoopCapture.mockRestore();
    await expect(engine.start()).rejects.toThrow("cannot be re-armed");
    engine.close();
    expect((await engine.search(request)).metadata.fallbackReason).toBe(
      "kernel_tool_call_write",
    );
  });

  it("builds a non-persistent trusted generation from a dirty session worktree", async () => {
    expect(() => new OptInKernelEngine({
      root: fixture,
      addonPath,
      sessionWorktreeSnapshot: true,
    })).toThrow("session worktree snapshots require a trusted mutation feed");

    await writeFile(path.join(fixture, "A.txt"), "before\nrecovered-session-hit\nafter\n");
    await writeFile(
      path.join(fixture, "src", "session-untracked.txt"),
      "recovered-session-hit untracked\n",
    );
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
      sessionWorktreeSnapshot: true,
    });

    const started = await engine.start();
    expect(started.reusedPersistentGeneration).toBe(false);
    const request: SearchRequest = {
      pattern: "recovered-session-hit",
      literal: true,
      context: 0,
      limit: null,
    };
    const kernel = await engine.search(request);
    const normal = await runRipgrep(fixture, request);
    expect(kernel.matches).toEqual(normal.matches);
    expect(kernel.metadata).toMatchObject({
      actualBackend: "kernel",
      totalMatches: 2,
    });
    await expect(
      readFile(`${engine.indexPath}.manifest.json`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    engine.close();
  });

  it("uses one source capture only for a trusted persistent open", async () => {
    const builder = new OptInKernelEngine({ root: fixture, addonPath });
    expect((await builder.start()).reusedPersistentGeneration).toBe(false);
    builder.close();

    const verified = new OptInKernelEngine({ root: fixture, addonPath });
    const binding = loadKernelBinding(addonPath);
    const nativeDigest = vi.spyOn(binding, "hashSourceContents");
    const verifiedCapture = vi.spyOn(
      verified as unknown as CaptureSourceProbe,
      "captureSource",
    );
    expect((await verified.start()).reusedPersistentGeneration).toBe(true);
    expect(verifiedCapture).toHaveBeenCalledTimes(2);
    expect(nativeDigest).not.toHaveBeenCalled();
    verifiedCapture.mockRestore();
    verified.close();

    const trusted = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const trustedProbe = trusted as unknown as StartProbe;
    const trustedCapture = vi.spyOn(trustedProbe, "captureSource");
    const trustedMetadata = vi.spyOn(trustedProbe, "captureSourceMetadata");
    const trustedFusedMetadata = vi.spyOn(
      trustedProbe,
      "captureFusedSourceMetadata",
    );
    const trustedContents = vi.spyOn(trustedProbe, "captureSourceContents");
    expect((await trusted.start()).reusedPersistentGeneration).toBe(true);
    expect(trustedCapture).not.toHaveBeenCalled();
    expect(trustedMetadata).not.toHaveBeenCalled();
    expect(trustedFusedMetadata).toHaveBeenCalledOnce();
    expect(trustedContents).toHaveBeenCalledOnce();
    expect(nativeDigest).toHaveBeenCalledOnce();
    trustedCapture.mockRestore();
    trustedMetadata.mockRestore();
    trustedFusedMetadata.mockRestore();
    trustedContents.mockRestore();
    trusted.close();

    const signaled = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const signaledCapture = vi.spyOn(
      signaled as unknown as CaptureSourceProbe,
      "captureSource",
    );
    const signaledFusedMetadata = vi.spyOn(
      signaled as unknown as StartProbe,
      "captureFusedSourceMetadata",
    );
    expect(
      (await signaled.start(new AbortController().signal)).reusedPersistentGeneration,
    ).toBe(true);
    expect(signaledCapture).toHaveBeenCalledOnce();
    expect(signaledFusedMetadata).not.toHaveBeenCalled();
    expect(nativeDigest).toHaveBeenCalledOnce();
    signaledCapture.mockRestore();
    signaledFusedMetadata.mockRestore();
    signaled.close();
    nativeDigest.mockRestore();
  });

  it("fuses a definite trusted cold build digest and still verifies warm reuse", async () => {
    await rm(path.join(fixture, "src", "\u{e000}.txt"), { force: true });
    await rm(path.join(fixture, "src", "😀.txt"), { force: true });
    await runCommand("git", ["add", "-A"], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "ascii-only fixture"], { cwd: fixture });
    const binding = loadKernelBinding(addonPath);
    const nativeDigest = vi.spyOn(binding, "hashSourceContents");
    const legacyBuild = vi.spyOn(binding, "buildKernelIndex");
    const fusedBuild = vi.spyOn(binding, "buildKernelIndexWithSourceDigest");
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const coldProbe = engine as unknown as StartProbe;
    const coldCapture = vi.spyOn(coldProbe, "captureSource");
    const coldMetadata = vi.spyOn(coldProbe, "captureSourceMetadata");
    const coldFusedMetadata = vi.spyOn(
      coldProbe,
      "captureFusedSourceMetadata",
    );
    const coldContents = vi.spyOn(coldProbe, "captureSourceContents");

    const coldStart = await engine.start();
    expect(coldStart.reusedPersistentGeneration).toBe(false);
    expect(coldStart.buildStats?.formatVersion).toBe(5);
    expect(coldStart.openStats.formatVersion).toBe(5);
    expect(coldCapture).not.toHaveBeenCalled();
    expect(coldMetadata).not.toHaveBeenCalled();
    expect(coldFusedMetadata).toHaveBeenCalledOnce();
    expect(coldContents).not.toHaveBeenCalled();
    expect(nativeDigest).not.toHaveBeenCalled();
    expect(legacyBuild).not.toHaveBeenCalled();
    expect(fusedBuild).toHaveBeenCalledOnce();
    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    expect((await engine.search(request)).matches).toEqual(
      (await runRipgrep(fixture, request)).matches,
    );

    coldCapture.mockRestore();
    coldMetadata.mockRestore();
    coldFusedMetadata.mockRestore();
    coldContents.mockRestore();
    engine.close();

    const warm = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const warmProbe = warm as unknown as StartProbe;
    const warmCapture = vi.spyOn(warmProbe, "captureSource");
    const warmMetadata = vi.spyOn(warmProbe, "captureSourceMetadata");
    const warmFusedMetadata = vi.spyOn(
      warmProbe,
      "captureFusedSourceMetadata",
    );
    const warmContents = vi.spyOn(warmProbe, "captureSourceContents");
    const warmStart = await warm.start();
    expect(warmStart.reusedPersistentGeneration).toBe(true);
    expect(warmStart.openStats.formatVersion).toBe(5);
    expect(warmCapture).not.toHaveBeenCalled();
    expect(warmMetadata).not.toHaveBeenCalled();
    expect(warmFusedMetadata).toHaveBeenCalledOnce();
    expect(warmContents).toHaveBeenCalledOnce();
    expect(nativeDigest).toHaveBeenCalledOnce();
    expect(legacyBuild).not.toHaveBeenCalled();
    expect(fusedBuild).toHaveBeenCalledOnce();
    expect((await warm.search(request)).matches).toEqual(
      (await runRipgrep(fixture, request)).matches,
    );

    warmCapture.mockRestore();
    warmMetadata.mockRestore();
    warmFusedMetadata.mockRestore();
    warmContents.mockRestore();
    fusedBuild.mockRestore();
    legacyBuild.mockRestore();
    nativeDigest.mockRestore();
    warm.close();
  });

  it("starts all fused metadata readers together and waits for every result", async () => {
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const probe = engine as unknown as FusedMetadataProbe;
    probe.canonicalRoot = fixture;
    const paths = deferred<string[]>();
    const head = deferred<CommandResult>();
    const status = deferred<CommandResult>();
    const listUniverse = vi
      .spyOn(probe, "listUniverse")
      .mockReturnValue(paths.promise);
    const readHead = vi
      .spyOn(probe, "readFusedGitHead")
      .mockReturnValue(head.promise);
    const readStatus = vi
      .spyOn(probe, "readFusedGitStatus")
      .mockReturnValue(status.promise);

    const expectedError = new Error("status failed after spawn");
    const capture = probe.captureFusedSourceMetadata();
    let settled = false;
    void capture.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(listUniverse).toHaveBeenCalledOnce();
    expect(readHead).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledOnce();

    status.reject(expectedError);
    await Promise.resolve();
    expect(settled).toBe(false);
    paths.resolve(["A.txt"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    head.resolve(commandResult());
    await expect(capture).rejects.toBe(expectedError);
    expect(settled).toBe(true);

    listUniverse.mockRestore();
    readHead.mockRestore();
    readStatus.mockRestore();
    engine.close();
  });

  it("preserves serial fused-metadata error precedence", async () => {
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const probe = engine as unknown as FusedMetadataProbe;
    probe.canonicalRoot = fixture;
    const listUniverse = vi.spyOn(probe, "listUniverse");
    const readHead = vi.spyOn(probe, "readFusedGitHead");
    const readStatus = vi.spyOn(probe, "readFusedGitStatus");
    const listError = new Error("list failed");
    const headError = new Error("head failed");
    const statusError = new Error("status failed");

    listUniverse.mockRejectedValueOnce(listError);
    readHead.mockRejectedValueOnce(headError);
    readStatus.mockRejectedValueOnce(statusError);
    await expect(probe.captureFusedSourceMetadata()).rejects.toBe(listError);

    listUniverse.mockResolvedValueOnce(["A.txt"]);
    readHead.mockRejectedValueOnce(headError);
    readStatus.mockRejectedValueOnce(statusError);
    await expect(probe.captureFusedSourceMetadata()).rejects.toBe(headError);

    listUniverse.mockResolvedValueOnce(["A.txt"]);
    readHead.mockResolvedValueOnce(commandResult({ code: 128, stdout: "" }));
    readStatus.mockRejectedValueOnce(statusError);
    await expect(probe.captureFusedSourceMetadata()).rejects.toThrow(
      "clean Git snapshot",
    );

    listUniverse.mockResolvedValueOnce(["A.txt"]);
    readHead.mockResolvedValueOnce(commandResult());
    readStatus.mockResolvedValueOnce(commandResult({ stdout: " M A.txt\0" }));
    await expect(probe.captureFusedSourceMetadata()).rejects.toThrow(
      "clean Git snapshot",
    );

    listUniverse.mockRestore();
    readHead.mockRestore();
    readStatus.mockRestore();
    engine.close();
  });

  it("rejects a generation marked while fused metadata readers are in flight", async () => {
    const feed = new KernelMutationFeed();
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: feed,
    });
    const probe = engine as unknown as FusedMetadataProbe;
    const paths = deferred<string[]>();
    const head = deferred<CommandResult>();
    const status = deferred<CommandResult>();
    const listUniverse = vi
      .spyOn(probe, "listUniverse")
      .mockReturnValue(paths.promise);
    const readHead = vi
      .spyOn(probe, "readFusedGitHead")
      .mockReturnValue(head.promise);
    const readStatus = vi
      .spyOn(probe, "readFusedGitStatus")
      .mockReturnValue(status.promise);
    const readManifest = vi.spyOn(probe, "readManifest");
    const binding = loadKernelBinding(addonPath);
    const fusedBuild = vi.spyOn(binding, "buildKernelIndexWithSourceDigest");

    const starting = engine.start();
    await vi.waitFor(() => {
      expect(listUniverse).toHaveBeenCalledOnce();
      expect(readHead).toHaveBeenCalledOnce();
      expect(readStatus).toHaveBeenCalledOnce();
    });
    feed.mark("kernel_tool_call_write");
    status.resolve(commandResult({ stdout: "" }));
    paths.resolve(["A.txt"]);
    await Promise.resolve();
    expect(readManifest).not.toHaveBeenCalled();
    head.resolve(commandResult());
    await expect(starting).rejects.toThrow("workspace changed during source capture");
    expect(readManifest).not.toHaveBeenCalled();
    expect(fusedBuild).not.toHaveBeenCalled();

    listUniverse.mockRestore();
    readHead.mockRestore();
    readStatus.mockRestore();
    readManifest.mockRestore();
    fusedBuild.mockRestore();
    engine.close();
  });

  it("keeps fused dirty and non-Git failures on the clean-snapshot boundary", async () => {
    await writeFile(path.join(fixture, "A.txt"), "dirty tracked source\n");
    const dirty = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });
    await expect(dirty.start()).rejects.toThrow("clean Git snapshot");
    dirty.close();

    const nonGitRoot = await realpath(await mkdtemp(path.join(tmpdir(), "pi-fast-grep-kernel-non-git-")));
    try {
      await writeFile(path.join(nonGitRoot, "source.txt"), "needle\n");
      const nonGit = new OptInKernelEngine({
        root: nonGitRoot,
        addonPath,
        trustedMutationFeed: new KernelMutationFeed(),
      });
      await expect(nonGit.start()).rejects.toThrow("clean Git snapshot");
      nonGit.close();
    } finally {
      await rm(nonGitRoot, { recursive: true, force: true });
    }
  });

  it("keeps a verified cold build on full captures and the legacy builder", async () => {
    const binding = loadKernelBinding(addonPath);
    const nativeDigest = vi.spyOn(binding, "hashSourceContents");
    const legacyBuild = vi.spyOn(binding, "buildKernelIndex");
    const fusedBuild = vi.spyOn(binding, "buildKernelIndexWithSourceDigest");
    const engine = new OptInKernelEngine({ root: fixture, addonPath });
    const capture = vi.spyOn(
      engine as unknown as CaptureSourceProbe,
      "captureSource",
    );
    const fusedMetadata = vi.spyOn(
      engine as unknown as StartProbe,
      "captureFusedSourceMetadata",
    );

    expect((await engine.start()).reusedPersistentGeneration).toBe(false);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(fusedMetadata).not.toHaveBeenCalled();
    expect(nativeDigest).not.toHaveBeenCalled();
    expect(legacyBuild).toHaveBeenCalledOnce();
    expect(fusedBuild).not.toHaveBeenCalled();

    capture.mockRestore();
    fusedMetadata.mockRestore();
    fusedBuild.mockRestore();
    legacyBuild.mockRestore();
    nativeDigest.mockRestore();
    engine.close();
  });

  it("keeps the verified second capture for a cancelable trusted cold build", async () => {
    const binding = loadKernelBinding(addonPath);
    const nativeDigest = vi.spyOn(binding, "hashSourceContents");
    const legacyBuild = vi.spyOn(binding, "buildKernelIndex");
    const fusedBuild = vi.spyOn(binding, "buildKernelIndexWithSourceDigest");
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      indexPath: path.join(fixture, ".pi", "index", "cancelable.pfg"),
      trustedMutationFeed: new KernelMutationFeed(),
    });
    const capture = vi.spyOn(
      engine as unknown as CaptureSourceProbe,
      "captureSource",
    );
    const fusedMetadata = vi.spyOn(
      engine as unknown as StartProbe,
      "captureFusedSourceMetadata",
    );

    expect(
      (await engine.start(new AbortController().signal)).reusedPersistentGeneration,
    ).toBe(false);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(fusedMetadata).not.toHaveBeenCalled();
    expect(nativeDigest).not.toHaveBeenCalled();
    expect(legacyBuild).toHaveBeenCalledOnce();
    expect(fusedBuild).not.toHaveBeenCalled();

    capture.mockRestore();
    fusedMetadata.mockRestore();
    fusedBuild.mockRestore();
    legacyBuild.mockRestore();
    nativeDigest.mockRestore();
    engine.close();
  });

  it("fails closed before a definite cold build when the mutation feed is marked", async () => {
    const feed = new KernelMutationFeed();
    const binding = loadKernelBinding(addonPath);
    const fusedBuild = vi.spyOn(binding, "buildKernelIndexWithSourceDigest");
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: feed,
    });
    const probe = engine as unknown as StartProbe;
    const metadata = vi.spyOn(probe, "captureFusedSourceMetadata");
    const contents = vi.spyOn(probe, "captureSourceContents");
    const readManifest = probe.readManifest.bind(engine);
    vi.spyOn(probe, "readManifest").mockImplementation(async () => {
      const manifest = await readManifest();
      expect(manifest).toBeUndefined();
      feed.mark("kernel_tool_call_write");
      await writeFile(
        path.join(fixture, "src", "before-build.txt"),
        "needle created before the build fence\n",
      );
      return manifest;
    });

    await expect(engine.start()).rejects.toThrow("workspace changed during source capture");
    expect(metadata).toHaveBeenCalledOnce();
    expect(contents).not.toHaveBeenCalled();
    expect(fusedBuild).not.toHaveBeenCalled();

    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    const fallback = await engine.search(request);
    expect(fallback.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_tool_call_write",
    });
    expect(fallback.matches).toEqual((await runRipgrep(fixture, request)).matches);
    expect(fallback.matches.map((match) => match.path)).toContain(
      "src/before-build.txt",
    );

    metadata.mockRestore();
    contents.mockRestore();
    fusedBuild.mockRestore();
    engine.close();
  });

  it("rejects a trusted cold build marked before its final generation fence", async () => {
    const feed = new KernelMutationFeed();
    const binding = loadKernelBinding(addonPath);
    const buildKernelIndexWithSourceDigest =
      binding.buildKernelIndexWithSourceDigest.bind(binding);
    const nativeBuild = vi
      .spyOn(binding, "buildKernelIndexWithSourceDigest")
      .mockImplementation((root, relativePaths, indexPath) => {
        const stats = buildKernelIndexWithSourceDigest(
          root,
          relativePaths,
          indexPath,
        );
        feed.mark("kernel_tool_call_write");
        writeFileSync(
          path.join(fixture, "src", "during-build.txt"),
          "needle created before the build fence\n",
        );
        return stats;
      });
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: feed,
    });
    const probe = engine as unknown as StartProbe;
    const capture = vi.spyOn(probe, "captureSource");
    const metadata = vi.spyOn(probe, "captureFusedSourceMetadata");
    const contents = vi.spyOn(probe, "captureSourceContents");

    await expect(engine.start()).rejects.toThrow(
      "agent-loop generation changed while building kernel index",
    );
    expect(capture).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledOnce();
    expect(contents).not.toHaveBeenCalled();
    expect(nativeBuild).toHaveBeenCalledOnce();
    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    const fallback = await engine.search(request);
    expect(fallback.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_tool_call_write",
    });
    expect(fallback.matches).toEqual((await runRipgrep(fixture, request)).matches);
    expect(fallback.matches.map((match) => match.path)).toContain(
      "src/during-build.txt",
    );

    capture.mockRestore();
    metadata.mockRestore();
    contents.mockRestore();
    nativeBuild.mockRestore();
    engine.close();
  });

  it("rejects a trusted persistent open marked after its source metadata capture", async () => {
    const builder = new OptInKernelEngine({ root: fixture, addonPath });
    await builder.start();
    builder.close();

    const feed = new KernelMutationFeed();
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: feed,
    });
    const probe = engine as unknown as StartProbe;
    const capture = vi.spyOn(probe, "captureSource");
    const metadata = vi.spyOn(probe, "captureFusedSourceMetadata");
    const contents = vi.spyOn(probe, "captureSourceContents");
    const readManifest = probe.readManifest.bind(engine);
    vi.spyOn(probe, "readManifest").mockImplementation(async () => {
      const manifest = await readManifest();
      expect(manifest).toBeDefined();
      feed.mark("kernel_tool_call_write");
      await writeFile(
        path.join(fixture, "src", "during-start.txt"),
        "needle created during rejected start\n",
      );
      return manifest;
    });

    await expect(engine.start()).rejects.toThrow(/workspace changed/u);
    expect(capture).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledOnce();
    expect(contents).toHaveBeenCalledOnce();
    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    const fallback = await engine.search(request);
    expect(fallback.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_tool_call_write",
    });
    expect(fallback.matches).toEqual((await runRipgrep(fixture, request)).matches);
    expect(fallback.matches.map((match) => match.path)).toContain(
      "src/during-start.txt",
    );
    await expect(engine.start()).rejects.toThrow("cannot be re-armed");
    metadata.mockRestore();
    contents.mockRestore();
    engine.close();
  });

  it("rejects malformed fused build identity before opening or publishing it", async () => {
    const binding = loadKernelBinding(addonPath);
    const buildKernelIndexWithSourceDigest =
      binding.buildKernelIndexWithSourceDigest.bind(binding);
    const fusedBuild = vi
      .spyOn(binding, "buildKernelIndexWithSourceDigest")
      .mockImplementation((root, relativePaths, indexPath) => ({
        ...buildKernelIndexWithSourceDigest(root, relativePaths, indexPath),
        contentSha256: "not-a-sha256",
      }));
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: new KernelMutationFeed(),
    });

    await expect(engine.start()).rejects.toThrow(
      "native fused build returned an invalid source identity",
    );
    expect(fusedBuild).toHaveBeenCalledOnce();
    await expect(
      readFile(`${engine.indexPath}.manifest.json`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const request: SearchRequest = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: null,
    };
    const fallback = await engine.search(request);
    expect(fallback.metadata).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_start_failed",
    });
    expect(fallback.matches).toEqual((await runRipgrep(fixture, request)).matches);

    fusedBuild.mockRestore();
    engine.close();
  });

  it("latches a host mutation mark that occurs before engine subscription", async () => {
    const feed = new KernelMutationFeed();
    feed.mark("kernel_tool_call_bash");
    const binding = loadKernelBinding(addonPath);
    const nativeDigest = vi.spyOn(binding, "hashSourceContents");
    const engine = new OptInKernelEngine({
      root: fixture,
      addonPath,
      trustedMutationFeed: feed,
    });
    await expect(engine.start()).rejects.toThrow("cannot be re-armed");
    expect(nativeDigest).not.toHaveBeenCalled();
    expect(feed.reason).toBe("kernel_tool_call_bash");
    engine.close();
    nativeDigest.mockRestore();
  });
});
