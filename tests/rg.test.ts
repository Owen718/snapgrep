import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listRipgrepFiles, runRipgrep } from "../src/rg.ts";

describe("runRipgrep", () => {
	let fixture: string;

	beforeEach(async () => {
		fixture = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-rg-"));
		await mkdir(path.join(fixture, "src"), { recursive: true });
		await mkdir(path.join(fixture, "notes"), { recursive: true });
		await writeFile(path.join(fixture, "src", "alpha.ts"), "first\nMixedCase\n[literal]\nlast\n");
		await writeFile(path.join(fixture, "src", "beta.js"), "mixedcase\n[literal]\n");
		await writeFile(path.join(fixture, "notes", "unicode.txt"), "😀 café finish\n");
	});

	afterEach(async () => {
		await rm(fixture, { recursive: true, force: true });
	});

	it("supports literal patterns, case folding, and globs", async () => {
		const literal = await runRipgrep(fixture, { pattern: "[literal]", literal: true, limit: null });
		expect(literal.matches.map((match) => match.path)).toEqual(["src/alpha.ts", "src/beta.js"]);

		const folded = await runRipgrep(fixture, {
			pattern: "mixedcase",
			ignoreCase: true,
			glob: "*.ts",
			limit: null,
		});
		expect(folded.matches).toHaveLength(1);
		expect(folded.matches[0]).toMatchObject({ path: "src/alpha.ts", lineNumber: 2, lineText: "MixedCase" });
	});

	it("searches hidden files by default but always excludes implementation directories", async () => {
		await mkdir(path.join(fixture, ".hidden-dir"), { recursive: true });
		await mkdir(path.join(fixture, ".git"), { recursive: true });
		await mkdir(path.join(fixture, ".pi", "index"), { recursive: true });
		await mkdir(path.join(fixture, ".fast-grep"), { recursive: true });
		await mkdir(path.join(fixture, "nested", ".git"), { recursive: true });
		await writeFile(path.join(fixture, ".hidden-dir", "visible.txt"), "probe\n");
		await writeFile(path.join(fixture, ".git", "excluded.txt"), "probe\n");
		await writeFile(path.join(fixture, ".pi", "index", "excluded.txt"), "probe\n");
		await writeFile(path.join(fixture, ".fast-grep", "excluded.txt"), "probe\n");
		await writeFile(path.join(fixture, "nested", ".git", "excluded.txt"), "probe\n");

		const defaultResult = await runRipgrep(fixture, { pattern: "probe", limit: null });
		expect(defaultResult.matches.map((match) => match.path)).toEqual([".hidden-dir/visible.txt"]);

		const withoutHidden = await runRipgrep(fixture, { pattern: "probe", hidden: false, limit: null });
		expect(withoutHidden.matches).toEqual([]);

		const explicitInternalPath = await runRipgrep(fixture, {
			pattern: "probe",
			path: "nested/.git/excluded.txt",
			limit: null,
		});
		expect(explicitInternalPath.matches).toEqual([]);
	});

	it("respects ignore files unless noIgnore is requested", async () => {
		await writeFile(path.join(fixture, ".gitignore"), "ignored.txt\n");
		await writeFile(path.join(fixture, "ignored.txt"), "ignore-probe\n");

		const respected = await runRipgrep(fixture, { pattern: "ignore-probe", limit: null });
		expect(respected.matches).toEqual([]);

		const bypassed = await runRipgrep(fixture, { pattern: "ignore-probe", noIgnore: true, limit: null });
		expect(bypassed.matches.map((match) => match.path)).toEqual(["ignored.txt"]);
	});

	it("parses multiline matches and absolute UTF-8 byte ranges", async () => {
		await writeFile(path.join(fixture, "src", "multi.txt"), "start\n😀 foo\nbar café\nend\n");

		const result = await runRipgrep(fixture, {
			pattern: "foo\\nbar",
			multiline: true,
			limit: null,
		});

		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			path: "src/multi.txt",
			lineNumber: 2,
			lineText: "😀 foo\nbar café",
			ranges: [{ absoluteStart: 11, absoluteEnd: 18, lineStart: 5, lineEnd: 12 }],
		});

		const unicode = await runRipgrep(fixture, { pattern: "café", literal: true, limit: null });
		expect(unicode.matches[0]?.ranges).toEqual([
			{ absoluteStart: 5, absoluteEnd: 10, lineStart: 5, lineEnd: 10 },
		]);
	});

	it("attaches asymmetric context around a match", async () => {
		const result = await runRipgrep(fixture, {
			pattern: "MixedCase",
			beforeContext: 1,
			afterContext: 2,
			limit: null,
		});

		expect(result.matches[0]).toMatchObject({ before: ["first"], after: ["[literal]", "last"] });
	});

	it("restricts searches to relative and absolute candidate files and deduplicates them", async () => {
		const alpha = path.join(fixture, "src", "alpha.ts");
		const result = await runRipgrep(
			fixture,
			{ pattern: "literal", limit: null },
			{
				candidates: ["src/alpha.ts", alpha],
				candidatePaths: [path.join(fixture, "src", "beta.js"), "../outside.txt"],
			},
		);

		expect(result.matches.map((match) => match.path)).toEqual(["src/alpha.ts", "src/beta.js"]);
		expect(result.metadata.totalMatches).toBe(2);

		const empty = await runRipgrep(fixture, { pattern: "(" }, { candidates: [] });
		expect(empty.matches).toEqual([]);
	});

	it("reuses a repo-relative eligible-path set for candidate verification", async () => {
		const request = { pattern: "literal", glob: "*.ts", limit: null } as const;
		const eligible = await listRipgrepFiles(fixture, request);
		expect([...eligible]).toEqual(["src/alpha.ts"]);

		const result = await runRipgrep(fixture, request, {
			candidates: ["src/alpha.ts", "src/beta.js"],
			eligiblePaths: eligible,
		});
		expect(result.matches.map((match) => match.path)).toEqual(["src/alpha.ts"]);
	});

	it("applies hidden, ignore, and glob filters to explicit candidates", async () => {
		await mkdir(path.join(fixture, ".hidden"), { recursive: true });
		await writeFile(path.join(fixture, ".hidden", "candidate.ts"), "candidate-probe\n");
		await writeFile(path.join(fixture, "ignored.ts"), "candidate-probe\n");
		await writeFile(path.join(fixture, "visible.js"), "candidate-probe\n");
		await writeFile(path.join(fixture, "visible.ts"), "candidate-probe\n");
		await writeFile(path.join(fixture, ".gitignore"), "ignored.ts\n");
		const candidates = [".hidden/candidate.ts", "ignored.ts", "visible.js", "visible.ts"];

		const filtered = await runRipgrep(
			fixture,
			{ pattern: "candidate-probe", hidden: false, limit: null },
			{ candidates },
		);
		expect(filtered.matches.map((match) => match.path)).toEqual(["visible.js", "visible.ts"]);

		const globbed = await runRipgrep(
			fixture,
			{ pattern: "candidate-probe", hidden: false, noIgnore: true, glob: "*.ts", limit: null },
			{ candidates },
		);
		expect(globbed.matches.map((match) => match.path)).toEqual(["ignored.ts", "visible.ts"]);

		const inclusive = await runRipgrep(
			fixture,
			{ pattern: "candidate-probe", noIgnore: true, glob: "*.ts", limit: null },
			{ candidates },
		);
		expect(inclusive.matches.map((match) => match.path)).toEqual([
			".hidden/candidate.ts",
			"ignored.ts",
			"visible.ts",
		]);
	});

	it("counts all matches before applying a global limit", async () => {
		await writeFile(path.join(fixture, "src", "many.txt"), "hit\nhit\nhit\n");
		const result = await runRipgrep(fixture, { pattern: "hit", limit: 2 });

		expect(result.matches).toHaveLength(2);
		expect(result.metadata).toMatchObject({ totalMatches: 3, displayedMatches: 2, truncated: true });

		const unlimited = await runRipgrep(fixture, { pattern: "hit", limit: null });
		expect(unlimited.matches).toHaveLength(3);
		expect(unlimited.metadata.truncated).toBe(false);
	});

	it("chunks large candidate argv lists while preserving the global count and limit", async () => {
		const candidates = Array.from({ length: 220 }, (_, index) =>
			`notes/candidate-${String(index).padStart(3, "0")}-${"x".repeat(100)}.txt`,
		);
		await Promise.all(
			candidates.map((candidate) => writeFile(path.join(fixture, candidate), `batch-probe-${candidate}\n`)),
		);

		const result = await runRipgrep(
			fixture,
			{ pattern: "batch-probe", literal: true, limit: 5 },
			{ candidates: [...candidates, candidates[0]!] },
		);

		expect(result.matches).toHaveLength(5);
		expect(result.metadata).toMatchObject({ totalMatches: 220, displayedMatches: 5, truncated: true });
	});

	it("surfaces invalid-regex stderr and honors abort signals", async () => {
		await expect(runRipgrep(fixture, { pattern: "(" })).rejects.toThrow(/regex|unclosed|error/i);

		const controller = new AbortController();
		controller.abort();
		await expect(runRipgrep(fixture, { pattern: "literal" }, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
