import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { FastGrepEngine } from "../src/engine.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

// This suite drives a real Zoekt sidecar, which only exists after
// scripts/build-zoekt.sh has run (and that needs a Go toolchain). Skip rather
// than fail when the binaries are absent, so a fresh clone can run `npm test`
// without building Zoekt first.
const zoektBinaries = ["zoekt-git-index", "zoekt-index", "zoekt-webserver"];
const zoektAvailable = zoektBinaries.every((name) =>
  existsSync(path.join(projectRoot, ".tools", name)));
const fixture = path.join(projectRoot, "benchmarks", "fixtures", "core");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

describe.skipIf(!zoektAvailable).sequential("FastGrepEngine with a real Zoekt sidecar", () => {
  let root: string;
  let engine: FastGrepEngine;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-engine-"));
    await cp(fixture, root, { recursive: true });
    await writeFile(
      path.join(root, "skipped-large.txt"),
      `${"x".repeat(2_200_000)}FG_SKIPPED_LARGE_TOKEN\n`,
    );
    await writeFile(
      path.join(root, "skipped-binary.bin"),
      Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from("FG_BINARY_ONLY_TOKEN")]),
    );
    await writeFile(
      path.join(root, "late-nul-binary.pb"),
      Buffer.concat([
        Buffer.alloc(128 * 1024, 97),
        Buffer.from([0]),
        Buffer.from("FG_LATE_BINARY_TOKEN\n"),
      ]),
    );
    await writeFile(
      path.join(root, "early-match-binary.bin"),
      Buffer.concat([Buffer.from("FG_BINARY_BEFORE_NUL_TOKEN"), Buffer.from([0]), Buffer.from("tail\n")]),
    );
    await writeFile(
      path.join(root, "late-match-before-nul.bin"),
      Buffer.concat([
        Buffer.from("FG_LATE_BINARY_BEFORE_NUL_TOKEN\n"),
        Buffer.alloc(128 * 1024, 97),
        Buffer.from([0]),
        Buffer.from("tail\n"),
      ]),
    );
    await writeFile(path.join(root, "A-upper.ts"), "FG_ORDER_TOKEN\n");
    await writeFile(path.join(root, "b-lower.ts"), "FG_ORDER_TOKEN\n");
    await writeFile(
      path.join(root, "direct-lines.txt"),
      "before\nFG_DIRECT_TOKEN FG_DIRECT_TOKEN\nFG_CALL_TOKEN(\nFG_CASE_TOKEN\nFG_CR_SPLIT_TOKEN\n",
    );
    await writeFile(
      path.join(root, "direct-crlf.txt"),
      "before\r\nFG_CRLF_TOKEN\nFG_CR_SPLIT_TOKEN\r\n",
    );
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Fast Grep Test");
    await git(root, "config", "user.email", "fast-grep@example.invalid");
    await git(root, "add", "-f", ".");
    await git(root, "commit", "-qm", "fixture");
    engine = new FastGrepEngine({
      root,
      indexOptions: {
        zoektGitIndexPath: path.join(projectRoot, ".tools", "zoekt-git-index"),
        zoektIndexPath: path.join(projectRoot, ".tools", "zoekt-index"),
        zoektWebserverPath: path.join(projectRoot, ".tools", "zoekt-webserver"),
      },
    });
    await engine.start({ waitForIndex: true });
  }, 30_000);

  afterAll(async () => {
    await engine?.stop();
    expect(engine?.indexManager.status().lifecycle).toBe("stopped");
    expect(engine?.indexManager.status().pid).toBeUndefined();
    if (root) {
      await rm(root, { recursive: true, force: true });
      // A completed stop is a quiescence barrier: an initialize/restart that
      // was already in flight must not recreate the removed index directory.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("uses indexed candidates and exact verification for a literal", async () => {
    const result = await engine.search({
      pattern: "FG_RARE_TOKEN",
      hidden: false,
      context: 0,
      limit: null,
    });
    expect(result.metadata.actualBackend).toBe("zoekt");
    expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([["src/main.ts", 1]]);
  });

  test("uses complete Zoekt content matches, including multiple hits on one line", async () => {
    const request = {
      pattern: "FG_DIRECT_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    expect(instant.metadata.actualBackend).toBe("zoekt");
    expect(instant.metadata.indexExactMatchLines).toBe(1);
    expect(instant.matches).toEqual(normal.matches);
    expect(instant.matches[0]?.ranges).toHaveLength(2);
  });

  test("uses exact content matches for a pure escaped-regex literal", async () => {
    const request = {
      pattern: String.raw`FG_CALL_TOKEN\(`,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    expect(instant.metadata.indexExactMatchLines).toBe(1);
    expect(instant.matches).toEqual(normal.matches);
  });

  test.each([
    {
      label: "context",
      request: { pattern: "FG_DIRECT_TOKEN", literal: true, hidden: false, context: 1, limit: null },
    },
    {
      label: "case folding",
      request: { pattern: "fg_case_token", literal: true, ignoreCase: true, hidden: false, context: 0, limit: null },
    },
    {
      label: "path filtering",
      request: { pattern: "FG_DIRECT_TOKEN", literal: true, path: "direct-lines.txt", hidden: false, context: 0, limit: null },
    },
    {
      label: "glob filtering",
      request: { pattern: "FG_DIRECT_TOKEN", literal: true, glob: "*.txt", hidden: false, context: 0, limit: null },
    },
  ])("keeps the whole-query ripgrep verifier for $label boundaries", async ({ request }) => {
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    expect(instant.metadata.indexExactMatchLines).toBeUndefined();
    expect(instant.matches).toEqual(normal.matches);
  });

  test("uses exact LF matches while verifying CR-bearing match lines by file", async () => {
    const request = {
      pattern: "FG_CR_SPLIT_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });

    expect(instant.metadata.actualBackend).toBe("zoekt");
    expect(instant.metadata.indexExactMatchLines).toBe(1);
    expect(instant.matches).toEqual(normal.matches);
    expect(instant.matches.map((match) => match.path)).toEqual([
      "direct-crlf.txt",
      "direct-lines.txt",
    ]);
  });

  test("does not resolve HEAD in the steady-state indexed query path", async () => {
    const currentCommit = vi.spyOn(engine.indexManager, "currentCommit");
    try {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const result = await engine.search({
          pattern: "FG_HEAD_CACHE_NO_MATCH",
          literal: true,
          hidden: false,
          context: 0,
          limit: null,
        });
        expect(result.metadata.actualBackend).toBe("zoekt");
        expect(result.matches).toHaveLength(0);
      }
      expect(currentCommit).not.toHaveBeenCalled();
    } finally {
      currentCommit.mockRestore();
    }
  });

  test("keeps path/glob filename planning a superset of exact ripgrep", async () => {
    const unfiltered = await engine.search({
      pattern: "FG_GLOB_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    });
    const requests = [
      { pattern: "FG_GLOB_TOKEN", literal: true, path: "src/sub", glob: "*.ts", hidden: false, context: 0, limit: null },
      { pattern: "FG_GLOB_TOKEN", literal: true, glob: "src/sub/**/*.ts", hidden: false, context: 0, limit: null },
      // Character classes are intentionally not translated to Zoekt. Exact rg
      // filtering must still preserve the result set through over-recall.
      { pattern: "FG_GLOB_TOKEN", literal: true, glob: "[mn]*.ts", hidden: false, context: 0, limit: null },
    ] as const;

    for (const request of requests) {
      const normal = await engine.search(request, { backend: "normal" });
      const instant = await engine.search(request, { backend: "instant" });
      expect(instant.metadata.actualBackend).toBe("zoekt");
      expect(instant.matches).toEqual(normal.matches);
    }
    const selective = await engine.search(requests[0], { backend: "instant" });
    expect(selective.metadata.indexMatchCount).toBeLessThan(unfiltered.metadata.indexMatchCount ?? Infinity);
  });

  test("scans files Zoekt deliberately marks as unindexed", async () => {
    const result = await engine.search({
      pattern: "FG_SKIPPED_LARGE_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    });
    expect(result.metadata.actualBackend).toBe("zoekt");
    expect(result.metadata.unindexedFiles).toBeGreaterThan(0);
    expect(result.matches.map((match) => match.path)).toEqual(["skipped-large.txt"]);
  });

  test("does not turn explicit candidate verification into binary-file false positives", async () => {
    const request = {
      pattern: "FG_BINARY_ONLY_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    expect(normal.matches).toHaveLength(0);
    expect(instant.matches).toHaveLength(0);
    expect(instant.metadata.actualBackend).toBe("zoekt");
    expect(instant.metadata.binaryFilesSkipped).toBeGreaterThan(0);
  });

  test("suppresses indexed binary candidates whose first NUL is after 64 KiB", async () => {
    const request = {
      pattern: "FG_LATE_BINARY_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    expect(normal.matches).toHaveLength(0);
    expect(instant.matches).toHaveLength(0);
    expect(instant.metadata.actualBackend).toBe("zoekt");
    expect(instant.metadata.binaryFilesSkipped).toBeGreaterThan(0);
  });

  test("matches ripgrep's distinct directory and explicit-file binary policies", async () => {
    const treeRequest = {
      pattern: "FG_BINARY_BEFORE_NUL_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normalTree = await engine.search(treeRequest, { backend: "normal" });
    const instantTree = await engine.search(treeRequest, { backend: "instant" });
    expect(normalTree.matches).toHaveLength(0);
    expect(instantTree.matches).toHaveLength(0);
    expect(instantTree.metadata.actualBackend).toBe("zoekt");
    expect(instantTree.metadata.binaryFilesSkipped).toBeGreaterThan(0);

    const fileRequest = { ...treeRequest, path: "early-match-binary.bin" };
    const normalFile = await engine.search(fileRequest, { backend: "normal" });
    const instantFile = await engine.search(fileRequest, { backend: "instant" });
    expect(instantFile.metadata.actualBackend).toBe("zoekt");
    expect(instantFile.metadata.binaryFilesSkipped).toBe(0);
    expect(instantFile.matches).toEqual(normalFile.matches);
    expect(instantFile.matches).toHaveLength(1);
  });

  test("reconciles the match prefix ripgrep can emit before a late binary marker", async () => {
    const request = {
      pattern: "FG_LATE_BINARY_BEFORE_NUL_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    // rg tree mode may emit either zero or the pre-NUL prefix depending on
    // SearchWorker buffer history. Neither one-shot result is a stable oracle.
    expect(normal.matches.length).toBeLessThanOrEqual(1);
    expect(instant.matches.length).toBeLessThanOrEqual(1);
    for (const result of [normal, instant]) {
      if (result.matches.length === 1) {
        expect(result.matches[0]?.path).toBe("late-match-before-nul.bin");
        expect(result.matches[0]?.ranges[0]?.absoluteStart).toBe(0);
      }
    }
    expect(instant.metadata.actualBackend).toBe("rg_fallback");
    expect(instant.metadata.fallbackReason).toContain("late binary candidate");
    expect(instant.metadata.timings.binaryReconciliationMs).toBeGreaterThan(0);
  });

  test("keeps capped path ordering identical to the normal backend", async () => {
    const request = {
      pattern: "FG_ORDER_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: 1,
    } as const;
    const normal = await engine.search(request, { backend: "normal" });
    const instant = await engine.search(request, { backend: "instant" });
    expect(normal.matches.map((item) => item.path)).toEqual(["A-upper.ts"]);
    expect(instant.matches.map((item) => item.path)).toEqual(["A-upper.ts"]);
    expect(instant.metadata.totalMatches).toBe(normal.metadata.totalMatches);
  });

  test("falls back for a path outside the indexed repository", async () => {
    const outside = `${root}-outside.txt`;
    await writeFile(outside, "FG_OUTSIDE_ROOT_TOKEN\n");
    try {
      const result = await engine.search({
        pattern: "FG_OUTSIDE_ROOT_TOKEN",
        literal: true,
        path: outside,
        hidden: false,
        context: 0,
        limit: null,
      });
      expect(result.metadata.actualBackend).toBe("rg_fallback");
      expect(result.metadata.fallbackReason).toContain("outside");
      expect(result.matches).toHaveLength(1);
    } finally {
      await rm(outside, { force: true });
    }
  });

  test("routes unsafe regex syntax through the full ripgrep fallback", async () => {
    const result = await engine.search({
      pattern: "(?x) FG_EXTENDED \\s+ TOKEN",
      hidden: false,
      context: 0,
      limit: null,
    });
    expect(result.metadata.actualBackend).toBe("rg_fallback");
    expect(result.metadata.fallbackReason).toContain("inline regex");
    expect(result.matches).toHaveLength(1);
  });

  test("suppresses stale base hits and overlays modified content", async () => {
    const mutable = path.join(root, "mutable.ts");
    const original = await readFile(mutable, "utf8");
    await writeFile(mutable, original.replace("FG_MUTABLE_OLD", "FG_MUTABLE_NEW"));
    engine.markToolPath(mutable);

    const fresh = await engine.search({ pattern: "FG_MUTABLE_NEW", hidden: false, context: 0, limit: null });
    const stale = await engine.search({ pattern: "FG_MUTABLE_OLD", hidden: false, context: 0, limit: null });
    expect(fresh.matches).toHaveLength(1);
    expect(fresh.metadata.realtimeFiles).toBeGreaterThan(0);
    expect(stale.matches).toHaveLength(0);

    const indexedAt = performance.now();
    await engine.flushIncrementalIndex(2_500);
    const indexed = await engine.search({ pattern: "FG_MUTABLE_NEW", hidden: false, context: 0, limit: null });
    expect(performance.now() - indexedAt).toBeLessThan(2_000);
    expect(indexed.metadata.actualBackend, indexed.metadata.fallbackReason).toBe("zoekt");
    expect(indexed.metadata.dirtyFiles).toBe(0);
    expect(indexed.metadata.overlayRevision).toBeGreaterThan(0);
    expect(indexed.matches).toHaveLength(1);
  });

  test("finds a new file immediately and honors a deletion tombstone", async () => {
    const created = path.join(root, "fresh-created.ts");
    await writeFile(created, 'export const probe = "FG_CREATED_NOW";\n');
    engine.markToolPath(created);
    const fresh = await engine.search({ pattern: "FG_CREATED_NOW", hidden: false, context: 0, limit: null });
    expect(fresh.matches.map((match) => match.path)).toEqual(["fresh-created.ts"]);
    await engine.flushIncrementalIndex(2_500);
    const indexedFresh = await engine.search({ pattern: "FG_CREATED_NOW", hidden: false, context: 0, limit: null });
    expect(indexedFresh.metadata.dirtyFiles).toBe(0);
    expect(indexedFresh.matches.map((match) => match.path)).toEqual(["fresh-created.ts"]);

    const deleted = path.join(root, "delete-me.ts");
    await unlink(deleted);
    engine.markToolPath(deleted);
    const gone = await engine.search({ pattern: "FG_DELETE_ME", hidden: false, context: 0, limit: null });
    expect(gone.matches).toHaveLength(0);
    await engine.flushIncrementalIndex(2_500);
    const indexedGone = await engine.search({ pattern: "FG_DELETE_ME", hidden: false, context: 0, limit: null });
    expect(indexedGone.metadata.dirtyFiles).toBe(0);
    expect(indexedGone.matches).toHaveLength(0);
  });

  test("refreshes a new HEAD and clears overlay paths once that commit is indexed", async () => {
    const committed = path.join(root, "commit-refresh.ts");
    await writeFile(committed, "FG_COMMITTED_REFRESH_TOKEN\n");
    engine.markToolPath(committed);
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "refresh fixture head");
    const newCommit = await git(root, "rev-parse", "HEAD");

    const stale = await engine.search({
      pattern: "FG_COMMITTED_REFRESH_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    });
    expect(stale.matches).toHaveLength(1);
    if (stale.metadata.actualBackend === "rg_fallback") {
      expect(stale.metadata.fallbackReason).toMatch(
        /HEAD freshness is pending|stale|index unavailable \(building\)|workspace changed/u,
      );
    } else {
      expect(stale.metadata.actualBackend).toBe("zoekt");
      if (stale.metadata.indexedCommit === newCommit) {
        // The new base was already published when this result was assembled.
        expect(stale.metadata.currentCommit).toBe(newCommit);
      } else {
        // The old base can remain recall-safe while the committed path is still
        // supplied by dirty/realtime or indexed-overlay coverage. Assert from
        // the result's atomic metadata, not a manager status that can advance
        // between the search and this observation.
        expect(
          (stale.metadata.dirtyFiles ?? 0)
          + (stale.metadata.realtimeFiles ?? 0)
          + (stale.metadata.overlayFiles ?? 0),
        ).toBeGreaterThan(0);
      }
    }

    const deadline = Date.now() + 10_000;
    while (
      (
        engine.indexManager.status().indexedCommit !== newCommit
        || !engine.indexManager.ready
        || !engine.indexManager.currentCommitSnapshot().known
      )
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const indexedRequest = {
      pattern: "FG_COMMITTED_REFRESH_TOKEN",
      literal: true,
      hidden: false,
      context: 0,
      limit: null,
    } as const;
    let indexed = await engine.search(indexedRequest);
    const coverageDeadline = Date.now() + 10_000;
    while (
      indexed.metadata.actualBackend === "rg_fallback"
      && indexed.metadata.fallbackReason?.includes("workspace dirty coverage unavailable")
      && Date.now() < coverageDeadline
    ) {
      // A transient git-status failure must fail safe, and the next snapshot
      // retries it. Wait for trusted coverage rather than treating that
      // conservative fallback as a stale-index correctness failure.
      await new Promise((resolve) => setTimeout(resolve, 50));
      indexed = await engine.search(indexedRequest);
    }
    expect(indexed.metadata.actualBackend, indexed.metadata.fallbackReason).toBe("zoekt");
    expect(indexed.metadata.indexedCommit).toBe(newCommit);
    expect(indexed.metadata.dirtyFiles).toBe(0);
    expect(indexed.matches.map((item) => item.path)).toEqual(["commit-refresh.ts"]);
  });

  test("falls back when the owned webserver is killed and quiesces its background restart", async () => {
    const pid = engine.indexManager.status().pid;
    expect(pid).toBeTypeOf("number");
    process.kill(pid as number, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await engine.search({ pattern: "FG_RARE_TOKEN", hidden: false, context: 0, limit: null });
    expect(result.metadata.actualBackend).toBe("rg_fallback");
    expect(result.metadata.fallbackReason).toMatch(/index unavailable|sidecar query failed/u);
    expect(result.matches).toHaveLength(1);
    await engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engine.indexManager.status().lifecycle).toBe("stopped");
    expect(engine.indexManager.status().pid).toBeUndefined();
  });
});
