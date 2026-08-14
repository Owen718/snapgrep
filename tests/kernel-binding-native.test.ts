import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import {
  readdir,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bigintToSafeNumber,
  loadKernelBinding,
  nativeKernelErrorCode,
  type NativeOccurrence,
} from "../src/kernel-binding.ts";
import { runRipgrep } from "../src/rg.ts";

const nativeEnabled = process.env.PI_FAST_GREP_NATIVE_TEST === "1";

function occurrenceKey(
  occurrence: Pick<NativeOccurrence, "path" | "absoluteStart" | "absoluteEnd">,
): string {
  return `${occurrence.path}\0${occurrence.absoluteStart}\0${occurrence.absoluteEnd}`;
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

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
}

async function referenceSourceDigest(
  root: string,
  relativePaths: readonly string[],
): Promise<{ contentSha256: string; sourceBytes: bigint }> {
  const hash = createHash("sha256");
  let sourceBytes = 0n;
  for (const relativePath of relativePaths) {
    const content = await readFile(path.join(root, relativePath));
    updateLengthFramed(hash, relativePath);
    updateLengthFramed(hash, content);
    sourceBytes += BigInt(content.byteLength);
  }
  return { contentSha256: hash.digest("hex"), sourceBytes };
}

describe.skipIf(!nativeEnabled)("native kernel binding", () => {
  let fixture: string;

  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(path.join(tmpdir(), "pi-fast-grep-kernel-napi-")));
    await mkdir(path.join(fixture, "src"), { recursive: true });
    await writeFile(path.join(fixture, "A.txt"), "needle needle\ncafé needle\n");
    await writeFile(path.join(fixture, "src", "é.txt"), "prefix needle suffix\n");
    await writeFile(path.join(fixture, "src", "\u{e000}.txt"), "needle private-use path\n");
    await writeFile(path.join(fixture, "src", "😀.txt"), "needle supplementary path\n");
    await writeFile(path.join(fixture, "src", "overlap.txt"), "aaaaa\n");
    await writeFile(path.join(fixture, "src", "empty.txt"), "nothing here\n");
    await writeFile(path.join(fixture, "src", "digest-empty.txt"), "");
    await writeFile(path.join(fixture, "src", "digest-large.txt"), "x".repeat(70_001));
    await writeFile(
      path.join(fixture, "src", "binary.bin"),
      Buffer.from("binary-hit\0tail", "utf8"),
    );
    await writeFile(
      path.join(fixture, "src", "after-nul.bin"),
      Buffer.from("\0post-nul-regex-hit", "utf8"),
    );
    await writeFile(
      path.join(fixture, "src", "post-nul-regex.txt"),
      "post-nul-regex-hit\n",
    );
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it("builds, mmaps, differentially queries, closes, and reopens", async () => {
    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));
    expect(binding.BINDING_ABI_VERSION).toBe(10);

    const relativePaths = [
      "A.txt",
      "src/after-nul.bin",
      "src/binary.bin",
      "src/empty.txt",
      "src/overlap.txt",
      "src/post-nul-regex.txt",
      "src/é.txt",
      "src/\u{e000}.txt",
      "src/😀.txt",
    ];
    const indexPath = path.join(fixture, ".pi", "index", "kernel.pfg");
    const built = binding.buildKernelIndex(fixture, relativePaths, indexPath);
    expect(typeof built.files).toBe("bigint");
    expect(built.files).toBe(9n);
    expect(built.binaryFiles).toBe(2n);
    expect(built.indexBytes).toBeGreaterThan(0n);
    expect(built.buildDurationNs).toBeGreaterThan(0n);

    const index = binding.KernelIndex.open(indexPath);
    expect(index.closed).toBe(false);
    expect(typeof index.openStats.indexBytes).toBe("bigint");
    expect(index.openStats.files).toBe(9n);

    for (const literal of ["needle", "café", "aaa", "absent-token"]) {
      const native = index.queryLiteral(literal);
      expect(native.requiresFallback).toBe(false);
      expect(native.utf8BomCandidateFiles).toEqual([]);
      expect(native.transcodedCandidateFiles).toEqual([]);
      expect(native.unsafeTranscodedFiles).toEqual([]);
      expect(native.unsafeCaseFoldFiles).toEqual([]);
      expect(typeof native.totalOccurrences).toBe("bigint");
      expect(typeof native.queryDurationNs).toBe("bigint");

      const normal = await runRipgrep(fixture, {
        pattern: literal,
        literal: true,
        context: 0,
        limit: null,
      });
      const expected = normal.matches.flatMap((match) =>
        match.ranges.map((range) =>
          occurrenceKey({
            path: match.path,
            absoluteStart: BigInt(range.absoluteStart),
            absoluteEnd: BigInt(range.absoluteEnd),
          }),
        ),
      );
      const actual = native.occurrences.map(occurrenceKey);
      expect(actual).toHaveLength(new Set(actual).size);
      expect(new Set(actual)).toEqual(new Set(expected));
      expect(native.totalOccurrences).toBe(BigInt(expected.length));
    }

    const scopedLiteral = index.queryLiteral("needle", "src");
    expect(scopedLiteral.occurrences.every((occurrence) =>
      occurrence.path.startsWith("src/"),
    )).toBe(true);
    expect(scopedLiteral.totalOccurrences).toBe(3n);

    const literalPlan = index.queryLiteral("needle");
    const literalPaths = [
      ...new Set(literalPlan.occurrences.map((occurrence) => occurrence.path)),
    ].sort();
    const literalVerified = await index.verifyLiteralCandidates(
      "needle",
      literalPaths,
      1,
      1,
      10,
      undefined,
    );
    const expectedLiteral = await runRipgrep(fixture, {
      pattern: "needle",
      literal: true,
      context: 1,
      limit: null,
    });
    expect(literalVerified.totalMatches).toBe(BigInt(expectedLiteral.matches.length));
    expect(literalVerified.totalOccurrences).toBe(literalPlan.totalOccurrences);
    expect(literalVerified.indexedOccurrences).toBe(literalPlan.totalOccurrences);
    expect(literalVerified.verifiedFiles).toBe(BigInt(literalPaths.length));
    expect(literalVerified.truncated).toBe(false);
    expect(
      literalVerified.matches.map((match) => ({
        path: match.path,
        lineNumber: Number(match.lineNumber),
        lineText: match.lineText,
        ranges: match.ranges.map((range) => ({
          absoluteStart: Number(range.absoluteStart),
          absoluteEnd: Number(range.absoluteEnd),
          lineStart: Number(range.lineStart),
          lineEnd: Number(range.lineEnd),
        })),
        before: match.before,
        after: match.after,
      })),
    ).toEqual(
      expectedLiteral.matches.map((match) => ({
        path: match.path,
        lineNumber: match.lineNumber,
        lineText: match.lineText,
        ranges: match.ranges,
        before: match.before,
        after: match.after,
      })),
    );
    const boundedLiteral = await index.verifyLiteralCandidates(
      "needle",
      literalPaths,
      0,
      0,
      11,
      1,
    );
    expect(boundedLiteral.matches).toHaveLength(1);
    expect(boundedLiteral.totalMatches).toBe(literalVerified.totalMatches);
    expect(boundedLiteral.totalOccurrences).toBe(literalVerified.totalOccurrences);
    expect(boundedLiteral.truncated).toBe(true);

    const binary = index.queryLiteral("binary-hit");
    expect(binary.requiresFallback).toBe(true);
    expect(binary.binaryMatchFiles).toEqual(["src/binary.bin"]);
    expect(binary.occurrences).toEqual([]);

    const regex = index.queryRegexCandidates("need.*");
    expect(regex).not.toBeNull();
    expect(regex).toMatchObject({
      complete: true,
      binaryCandidatePaths: [],
      utf8BomCandidatePaths: [],
      transcodedCandidatePaths: [],
      unsafeTranscodedPaths: [],
    });
    expect(regex?.mandatoryGrams).toBeGreaterThan(0n);
    expect(regex?.candidateFiles).toBeGreaterThan(0n);
    expect(regex?.candidatePaths).toHaveLength(new Set(regex?.candidatePaths).size);
    expect(regex?.candidatePaths).toContain("A.txt");
    const regexPaths = [...(regex?.candidatePaths ?? [])].sort();
    expect(index.activeJobs).toBe(0);
    const verified = await index.verifyRegexCandidates(
      "need.*",
      regexPaths,
      0,
      0,
      1,
      undefined,
    );
    expect(index.activeJobs).toBe(0);
    const expectedRegex = await runRipgrep(fixture, {
      pattern: "need.*",
      hidden: true,
      context: 0,
      limit: null,
    });
    expect(verified.totalMatches).toBe(BigInt(expectedRegex.matches.length));
    expect(verified.verifiedFiles).toBe(BigInt(regexPaths.length));
    expect(verified.truncated).toBe(false);
    expect(
      verified.matches.map((match) => ({
        path: match.path,
        lineNumber: Number(match.lineNumber),
        lineText: match.lineText,
        ranges: match.ranges.map((range) => ({
          absoluteStart: Number(range.absoluteStart),
          absoluteEnd: Number(range.absoluteEnd),
          lineStart: Number(range.lineStart),
          lineEnd: Number(range.lineEnd),
        })),
      })),
    ).toEqual(
      expectedRegex.matches.map((match) => ({
        path: match.path,
        lineNumber: match.lineNumber,
        lineText: match.lineText,
        ranges: match.ranges,
      })),
    );
    const boundedVerified = await index.verifyRegexCandidates(
      "need.*",
      regexPaths,
      0,
      0,
      2,
      1,
    );
    expect(boundedVerified.matches).toHaveLength(1);
    expect(boundedVerified.totalMatches).toBe(verified.totalMatches);
    expect(boundedVerified.truncated).toBe(true);
    expect(index.queryRegexCandidates("foo|bar")).toBeNull();
    expect(index.queryRegexCandidates("(?<=needle) suffix")).toBeNull();

    for (const pattern of [
      "need(?:le)+",
      "needle|needful",
      "(?P<word>needle)",
      String.raw`\bneedle\b`,
      String.raw`\p{Ll}{3,}dle`,
      "(?x) nee dle",
      "need.*suffix",
      "needle{1,3}",
    ]) {
      const planned = index.queryRegexCandidates(pattern);
      expect(planned, pattern).not.toBeNull();
      const candidateSuperset = new Set([
        ...(planned?.candidatePaths ?? []),
        ...(planned?.binaryCandidatePaths ?? []),
        ...(planned?.utf8BomCandidatePaths ?? []),
        ...(planned?.transcodedCandidatePaths ?? []),
        ...(planned?.unsafeTranscodedPaths ?? []),
      ]);
      const normal = await runRipgrep(fixture, {
        pattern,
        hidden: true,
        context: 0,
        limit: null,
      });
      for (const match of normal.matches) {
        expect(candidateSuperset.has(match.path), `${pattern}: ${match.path}`).toBe(true);
      }
    }

    const binaryRegex = index.queryRegexCandidates("binary-(?:hit|miss)");
    expect(binaryRegex?.binaryCandidatePaths).toEqual(["src/binary.bin"]);

    const prunedBinaryRegex = index.queryRegexCandidates(
      "post-nul-regex-(?:hit|miss)",
    );
    expect(prunedBinaryRegex?.binaryCandidatePaths).toEqual([]);
    expect(prunedBinaryRegex?.candidatePaths).toEqual(["src/post-nul-regex.txt"]);

    expect(() => index.queryLiteral("aa")).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("[PFG_UNSUPPORTED_LITERAL]") }),
    );
    try {
      index.queryLiteral("aa");
    } catch (error) {
      expect(nativeKernelErrorCode(error)).toBe("PFG_UNSUPPORTED_LITERAL");
    }

    expect(bigintToSafeNumber(index.openStats.files, "openStats.files")).toBe(9);
    expect(index.close()).toBe(true);
    expect(index.close()).toBe(false);
    expect(index.closed).toBe(true);
    expect(() => index.queryLiteral("needle")).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("[PFG_CLOSED]") }),
    );

    const reopened = binding.KernelIndex.open(indexPath);
    expect(reopened.queryLiteral("needle").totalOccurrences).toBe(6n);
    reopened.close();

    const handle = await open(indexPath, "r+");
    try {
      const last = (await handle.stat()).size - 1;
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, last);
      byte[0] = (byte[0] as number) ^ 0xff;
      await handle.write(byte, 0, 1, last);
      await handle.sync();
    } finally {
      await handle.close();
    }
    expect(() => binding.KernelIndex.open(indexPath)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("[PFG_CORRUPT_INDEX]") }),
    );
  });

  it("cancels async in-process verification and releases Arc jobs after close", async () => {
    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));
    await writeFile(path.join(fixture, "src", "cancel.txt"), "x".repeat(8 * 1024 * 1024));
    const indexPath = path.join(fixture, ".pi", "index", "cancel.pfg");
    binding.buildKernelIndexWithSourceDigest(
      fixture,
      ["src/cancel.txt"],
      indexPath,
    );
    const index = binding.KernelIndex.open(indexPath);
    const literalVerifying = index.verifyLiteralCandidates(
      "xxx",
      ["src/cancel.txt"],
      0,
      0,
      3,
      undefined,
    );
    expect(index.activeJobs).toBe(1);
    expect(index.cancelRegexVerification(3)).toBe(true);
    await expect(literalVerifying).rejects.toThrow(/abort|cancel/iu);
    let deadline = Date.now() + 2_000;
    while (index.activeJobs !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(index.activeJobs).toBe(0);

    const regexVerifying = index.verifyRegexCandidates(
      "x",
      ["src/cancel.txt"],
      0,
      0,
      4,
      undefined,
    );
    expect(index.activeJobs).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(index.cancelRegexVerification(4)).toBe(true);
    expect(index.close()).toBe(true);
    await expect(regexVerifying).rejects.toThrow(/abort|cancel/iu);
    deadline = Date.now() + 2_000;
    while (index.activeJobs !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(index.activeJobs).toBe(0);
  });

  it("verifies valid UTF-8 BOM offsets natively and isolates unsupported transcoding", async () => {
    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));

    await writeFile(path.join(fixture, "src", "plain.txt"), "prefix needle suffix\n");
    await writeFile(
      path.join(fixture, "src", "utf8-bom.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("prefix needle suffix\n"),
      ]),
    );
    await writeFile(
      path.join(fixture, "src", "utf8-malformed.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf, 0xf0, 0x28, 0x8c, 0x28]),
        Buffer.from(" needle suffix\n"),
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
        utf16WithBom(" needle\n", "le").subarray(2),
      ]),
    );
    await writeFile(
      path.join(fixture, "src", "utf16-decoded-nul.txt"),
      utf16WithBom("needle\0tail\n", "le"),
    );

    const relativePaths = [
      "src/plain.txt",
      "src/utf8-bom.txt",
      "src/utf8-malformed.txt",
      "src/utf16be.txt",
      "src/utf16-decoded-nul.txt",
      "src/utf16-malformed.txt",
      "src/utf16le.txt",
    ];
    const indexPath = path.join(fixture, ".pi", "index", "bom.pfg");
    binding.buildKernelIndex(fixture, relativePaths, indexPath);
    const index = binding.KernelIndex.open(indexPath);
    try {
      const literal = index.queryLiteral("needle");
      expect(literal.occurrences.map((occurrence) => occurrence.path)).toEqual([
        "src/plain.txt",
      ]);
      expect(literal.utf8BomCandidateFiles).toEqual(["src/utf8-bom.txt"]);
      expect(literal.transcodedCandidateFiles).toEqual([
        "src/utf16-malformed.txt",
        "src/utf16be.txt",
        "src/utf16le.txt",
        "src/utf8-bom.txt",
        "src/utf8-malformed.txt",
      ]);
      expect(literal.unsafeTranscodedFiles).toEqual([
        "src/utf16-decoded-nul.txt",
      ]);
      expect(literal.requiresFallback).toBe(true);

      const absent = index.queryLiteral("absent-token");
      expect(absent.occurrences).toEqual([]);
      expect(absent.transcodedCandidateFiles).toEqual(
        literal.transcodedCandidateFiles,
      );
      expect(absent.unsafeTranscodedFiles).toEqual(
        literal.unsafeTranscodedFiles,
      );

      const literalVerified = await index.verifyLiteralCandidates(
        "needle",
        ["src/plain.txt", "src/utf8-bom.txt"],
        0,
        0,
        40,
      );
      expect(literalVerified.totalMatches).toBe(2n);
      expect(literalVerified.totalOccurrences).toBe(2n);
      expect(literalVerified.indexedOccurrences).toBe(1n);
      expect(literalVerified.matches[1]).toMatchObject({
        path: "src/utf8-bom.txt",
        lineNumber: 1n,
        lineText: "prefix needle suffix",
        ranges: [{ absoluteStart: 7n, absoluteEnd: 13n, lineStart: 7n, lineEnd: 13n }],
      });

      await expect(
        index.verifyLiteralCandidates(
          "needle",
          ["src/utf8-malformed.txt"],
          0,
          0,
          42,
        ),
      ).rejects.toThrow("[PFG_UNSUPPORTED_LITERAL]");
      await expect(
        index.verifyLiteralCandidates(
          "needle",
          ["src/utf16le.txt"],
          0,
          0,
          43,
        ),
      ).rejects.toThrow("[PFG_UNSUPPORTED_LITERAL]");

      const regex = index.queryRegexCandidates("need.*");
      expect(regex?.candidatePaths).toEqual(["src/plain.txt"]);
      expect(regex?.utf8BomCandidatePaths).toEqual(["src/utf8-bom.txt"]);
      expect(regex?.transcodedCandidatePaths).toEqual([
        "src/utf16-malformed.txt",
        "src/utf16be.txt",
        "src/utf16le.txt",
        "src/utf8-malformed.txt",
      ]);
      expect(regex?.unsafeTranscodedPaths).toEqual(
        literal.unsafeTranscodedFiles,
      );

      const verified = await index.verifyRegexCandidates(
        "need.*",
        ["src/plain.txt", "src/utf8-bom.txt"],
        0,
        0,
        41,
      );
      expect(verified.totalMatches).toBe(2n);
      expect(verified.verifiedFiles).toBe(2n);
      expect(verified.matches.map((match) => match.path)).toEqual([
        "src/plain.txt",
        "src/utf8-bom.txt",
      ]);
      expect(verified.matches[1]).toMatchObject({
        lineNumber: 1n,
        lineText: "prefix needle suffix",
        ranges: [{ absoluteStart: 7n, absoluteEnd: 20n, lineStart: 7n, lineEnd: 20n }],
      });
      await expect(
        index.verifyRegexCandidates(
          "need.*",
          ["src/utf8-malformed.txt"],
          0,
          0,
          44,
        ),
      ).rejects.toThrow("[PFG_UNSUPPORTED_REGEX]");
    } finally {
      index.close();
    }
  });

  it("fuses the caller-ordered manifest digest without changing exact index bytes", async () => {
    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));
    const callerPaths = [
      "src/\u{e000}.txt",
      "src/😀.txt",
      "src/digest-large.txt",
      "src/digest-empty.txt",
      "src/binary.bin",
      "A.txt",
    ].sort();
    const byteOrderedPaths = [...callerPaths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
    expect(callerPaths).not.toEqual(byteOrderedPaths);
    expect(callerPaths.indexOf("src/😀.txt")).toBeLessThan(
      callerPaths.indexOf("src/\u{e000}.txt"),
    );
    expect(byteOrderedPaths.indexOf("src/\u{e000}.txt")).toBeLessThan(
      byteOrderedPaths.indexOf("src/😀.txt"),
    );

    const baselinePath = path.join(fixture, ".pi", "index", "baseline.pfg");
    const fusedPath = path.join(fixture, ".pi", "index", "fused.pfg");
    const reversedPath = path.join(fixture, ".pi", "index", "reversed.pfg");
    const expected = await referenceSourceDigest(fixture, callerPaths);
    const baseline = binding.buildKernelIndex(fixture, callerPaths, baselinePath);
    const fused = binding.buildKernelIndexWithSourceDigest(
      fixture,
      callerPaths,
      fusedPath,
    );

    expect(fused).toMatchObject({
      formatVersion: baseline.formatVersion,
      files: baseline.files,
      binaryFiles: baseline.binaryFiles,
      grams: baseline.grams,
      postings: baseline.postings,
      indexBytes: baseline.indexBytes,
      contentSha256: expected.contentSha256,
      sourceBytes: expected.sourceBytes,
    });
    expect(fused.buildDurationNs).toBeGreaterThan(0n);
    const baselineBytes = await readFile(baselinePath);
    expect(await readFile(fusedPath)).toEqual(baselineBytes);

    const reversedCallerPaths = [...callerPaths].reverse();
    const reversedExpected = await referenceSourceDigest(
      fixture,
      reversedCallerPaths,
    );
    const reversed = binding.buildKernelIndexWithSourceDigest(
      fixture,
      reversedCallerPaths,
      reversedPath,
    );
    expect(reversed).toMatchObject({
      contentSha256: reversedExpected.contentSha256,
      sourceBytes: reversedExpected.sourceBytes,
      files: fused.files,
      binaryFiles: fused.binaryFiles,
      grams: fused.grams,
      postings: fused.postings,
      indexBytes: fused.indexBytes,
    });
    expect(reversed.contentSha256).not.toBe(fused.contentSha256);
    expect(await readFile(reversedPath)).toEqual(baselineBytes);

    const baselineIndex = binding.KernelIndex.open(baselinePath);
    const fusedIndex = binding.KernelIndex.open(fusedPath);
    const reversedIndex = binding.KernelIndex.open(reversedPath);
    try {
      const baselineQuery = baselineIndex.queryLiteral("needle");
      for (const query of [
        fusedIndex.queryLiteral("needle"),
        reversedIndex.queryLiteral("needle"),
      ]) {
        expect(query).toMatchObject({
          occurrences: baselineQuery.occurrences,
          totalOccurrences: baselineQuery.totalOccurrences,
          candidateFiles: baselineQuery.candidateFiles,
          binaryMatchFiles: baselineQuery.binaryMatchFiles,
          requiresFallback: baselineQuery.requiresFallback,
        });
        expect(query.queryDurationNs).toBeGreaterThanOrEqual(0n);
      }
    } finally {
      reversedIndex.close();
      fusedIndex.close();
      baselineIndex.close();
    }
  });

  it("builds and reopens deterministic variable-gram content-first v5 for byte-sorted inputs", async () => {
    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));
    const relativePaths = [
      "A.txt",
      "src/binary.bin",
      "src/digest-empty.txt",
      "src/digest-large.txt",
      "src/empty.txt",
      "src/overlap.txt",
    ];
    const byteOrderedPaths = [...relativePaths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
    expect(relativePaths).toEqual(byteOrderedPaths);

    const baselinePath = path.join(fixture, ".pi", "index", "baseline-v1.pfg");
    const fusedPath = path.join(fixture, ".pi", "index", "fused-v5.pfg");
    const repeatedPath = path.join(fixture, ".pi", "index", "repeated-v5.pfg");
    const expected = await referenceSourceDigest(fixture, relativePaths);
    const baseline = binding.buildKernelIndex(fixture, relativePaths, baselinePath);
    const fused = binding.buildKernelIndexWithSourceDigest(
      fixture,
      relativePaths,
      fusedPath,
    );
    const repeated = binding.buildKernelIndexWithSourceDigest(
      fixture,
      relativePaths,
      repeatedPath,
    );

    expect(baseline.formatVersion).toBe(1);
    expect(fused).toMatchObject({
      formatVersion: 5,
      files: baseline.files,
      binaryFiles: baseline.binaryFiles,
      grams: baseline.grams,
      postings: baseline.postings,
      contentSha256: expected.contentSha256,
      sourceBytes: expected.sourceBytes,
    });
    expect(fused.indexBytes).toBeLessThan(baseline.indexBytes);
    expect(repeated.formatVersion).toBe(5);
    const baselineBytes = await readFile(baselinePath);
    const fusedBytes = await readFile(fusedPath);
    expect(fusedBytes.byteLength).toBeLessThan(baselineBytes.byteLength);
    expect(fusedBytes).not.toEqual(baselineBytes);
    expect(await readFile(repeatedPath)).toEqual(fusedBytes);

    const baselineIndex = binding.KernelIndex.open(baselinePath);
    const fusedIndex = binding.KernelIndex.open(fusedPath);
    try {
      expect(baselineIndex.openStats.formatVersion).toBe(1);
      expect(fusedIndex.openStats.formatVersion).toBe(5);
      const baselineQuery = baselineIndex.queryLiteral("needle");
      expect(fusedIndex.queryLiteral("needle")).toMatchObject({
        occurrences: baselineQuery.occurrences,
        totalOccurrences: baselineQuery.totalOccurrences,
        candidateFiles: baselineQuery.candidateFiles,
        binaryMatchFiles: baselineQuery.binaryMatchFiles,
        requiresFallback: baselineQuery.requiresFallback,
      });
    } finally {
      fusedIndex.close();
      baselineIndex.close();
    }
  });

  it("streams the exact manifest-v2 digest and reads the JS path array lazily", async () => {
    const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
    const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
    expect(addons).toHaveLength(1);
    const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));
    const relativePaths = [
      "src/😀.txt",
      "src/digest-empty.txt",
      "A.txt",
      "src/digest-large.txt",
      "src/\u{e000}.txt",
    ];
    const canonicalRoot = await realpath(fixture);
    const expected = await referenceSourceDigest(fixture, relativePaths);
    const actual = binding.hashSourceContents(
      fixture,
      canonicalRoot,
      relativePaths,
    );
    expect(actual).toMatchObject({
      contentSha256: expected.contentSha256,
      files: BigInt(relativePaths.length),
      sourceBytes: expected.sourceBytes,
    });
    expect(actual.durationNs).toBeGreaterThan(0n);
    let secondElementReads = 0;
    const lazyPaths = new Array<string>(2);
    Object.defineProperty(lazyPaths, 0, {
      configurable: true,
      get: () => "../escape.txt",
    });
    Object.defineProperty(lazyPaths, 1, {
      configurable: true,
      get: () => {
        secondElementReads += 1;
        return "A.txt";
      },
    });
    expect(() =>
      binding.hashSourceContents(fixture, canonicalRoot, lazyPaths)
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("[PFG_INVALID_RELATIVE_PATH]"),
      }),
    );
    expect(secondElementReads).toBe(0);

  });

  it.skipIf(process.platform === "win32")(
    "fails closed when a later lazy path getter retargets its parent outside the root",
    async () => {
      const bindingDirectory = path.resolve(import.meta.dirname, "..", "native", "kernel", "binding");
      const addons = (await readdir(bindingDirectory)).filter((entry) => entry.endsWith(".node"));
      expect(addons).toHaveLength(1);
      const binding = loadKernelBinding(path.join(bindingDirectory, addons[0] as string));
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), "pi-fast-grep-kernel-outside-")));
      try {
        await mkdir(path.join(fixture, "safe"));
        await writeFile(path.join(fixture, "safe", "a.txt"), "inside-a");
        await writeFile(path.join(fixture, "safe", "b.txt"), "inside-b");
        const canonicalRoot = await realpath(fixture);
        const relativePaths = new Array<string>(2);
        let retargeted = false;
        Object.defineProperty(relativePaths, 0, {
          configurable: true,
          get: () => "safe/a.txt",
        });
        Object.defineProperty(relativePaths, 1, {
          configurable: true,
          get: () => {
            const movedParent = path.join(outside, "moved");
            renameSync(path.join(fixture, "safe"), movedParent);
            symlinkSync(movedParent, path.join(fixture, "safe"), "dir");
            retargeted = true;
            return "safe/b.txt";
          },
        });
        expect(() =>
          binding.hashSourceContents(fixture, canonicalRoot, relativePaths)
        ).toThrowError(
          expect.objectContaining({
            message: expect.stringContaining("[PFG_INVALID_RELATIVE_PATH]"),
          }),
        );
        expect(retargeted).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
});
