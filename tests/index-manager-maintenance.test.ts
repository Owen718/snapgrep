import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import {
  IndexManager,
  installProjectIndexIgnore,
  overlayShardPrefix,
  vacuumOwnedIndexArtifacts,
  vacuumStaleIndexTemporaries,
} from "../src/index-manager.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), name));
  roots.push(root);
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installProjectIndexIgnore", () => {
  test("preserves local excludes, installs one anchored rule, and hides index artifacts", async () => {
    const root = await temporaryRoot("pi-fast-grep-ignore-");
    await git(root, "init", "-q");
    const excludePath = path.join(root, ".git", "info", "exclude");
    await writeFile(excludePath, "# preserve me\n/custom-local-rule/\n");
    const indexDir = path.join(root, ".pi", "index", "fast-grep");
    await mkdir(indexDir, { recursive: true });
    await writeFile(path.join(indexDir, "state.json"), "{}\n");

    const first = await installProjectIndexIgnore(root, indexDir);
    const second = await installProjectIndexIgnore(root, indexDir);

    expect(first).toBe("/.pi/index/fast-grep/");
    expect(second).toBe(first);
    const exclude = await readFile(excludePath, "utf8");
    expect(exclude).toContain("# preserve me\n/custom-local-rule/\n");
    expect(exclude.match(/^\/\.pi\/index\/fast-grep\/$/gmu)).toHaveLength(1);
    await expect(git(root, "check-ignore", ".pi/index/fast-grep/state.json")).resolves.toBe(
      ".pi/index/fast-grep/state.json",
    );
    await expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).resolves.toBe("");
  });

  test("does not alter Git excludes for an external index directory", async () => {
    const root = await temporaryRoot("pi-fast-grep-ignore-external-");
    const external = await temporaryRoot("pi-fast-grep-external-index-");
    await git(root, "init", "-q");
    const excludePath = path.join(root, ".git", "info", "exclude");
    const before = await readFile(excludePath, "utf8");

    await expect(installProjectIndexIgnore(root, external)).resolves.toBeUndefined();
    await expect(readFile(excludePath, "utf8")).resolves.toBe(before);
  });

  test("uses git-path correctly from a linked worktree", async () => {
    const parent = await temporaryRoot("pi-fast-grep-linked-parent-");
    const main = path.join(parent, "main");
    const linked = path.join(parent, "linked");
    await mkdir(main);
    await git(main, "init", "-q");
    await git(main, "config", "user.name", "Fast Grep Test");
    await git(main, "config", "user.email", "fast-grep@example.invalid");
    await writeFile(path.join(main, "tracked.txt"), "tracked\n");
    await git(main, "add", "tracked.txt");
    await git(main, "commit", "-qm", "fixture");
    await git(main, "worktree", "add", "-q", "-b", "linked-test", linked);

    const indexDir = path.join(linked, ".pi", "index", "fast-grep");
    await mkdir(indexDir, { recursive: true });
    await writeFile(path.join(indexDir, "state.json"), "{}\n");
    await expect(installProjectIndexIgnore(linked, indexDir)).resolves.toBe(
      "/.pi/index/fast-grep/",
    );
    await expect(
      git(linked, "check-ignore", ".pi/index/fast-grep/state.json"),
    ).resolves.toBe(".pi/index/fast-grep/state.json");
  });
});

describe("IndexManager HEAD cache", () => {
  test("resolves HEAD once until the dirty-tracking seam invalidates it", async () => {
    const root = await temporaryRoot("pi-fast-grep-head-cache-");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Fast Grep Test");
    await git(root, "config", "user.email", "fast-grep@example.invalid");
    await writeFile(path.join(root, "tracked.txt"), "first\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-qm", "first");

    const manager = new IndexManager({ root });
    const first = await manager.currentCommit();
    expect(await manager.currentCommit()).toBe(first);
    expect(manager.currentCommitSnapshot()).toMatchObject({
      generation: 0,
      known: true,
      commit: first,
    });

    await writeFile(path.join(root, "tracked.txt"), "second\n");
    await git(root, "commit", "-qam", "second");
    const second = await git(root, "rev-parse", "HEAD");
    expect(second).not.toBe(first);
    expect(await manager.currentCommit()).toBe(first);

    manager.invalidateCurrentCommit();
    expect(manager.currentCommitSnapshot()).toMatchObject({
      generation: 1,
      known: false,
    });
    expect(await manager.currentCommit()).toBe(second);
  });
});

describe("vacuumOwnedIndexArtifacts", () => {
  test("removes cross-root overlay shards and stale temporaries but preserves every base shard", async () => {
    const root = await temporaryRoot("pi-fast-grep-vacuum-");
    const indexDir = path.join(root, "index");
    await mkdir(path.join(indexDir, "overlay-source", "nested"), { recursive: true });
    const sourcePrefix = overlayShardPrefix(path.join(root, "source-checkout"));
    const clonePrefix = overlayShardPrefix(path.join(root, "cloned-checkout"));
    expect(sourcePrefix).not.toBe(clonePrefix);

    const removed = [
      `${sourcePrefix}_v16.00000.zoekt`,
      `${sourcePrefix}_v16.00000.zoekt.meta`,
      `${clonePrefix}_v16.00001.zoekt`,
      "overlay.meta.json",
    ];
    for (const file of removed) await writeFile(path.join(indexDir, file), "overlay\n");
    await writeFile(path.join(indexDir, "overlay-source", "nested", "copy.ts"), "copy\n");

    const oldTemp = path.join(indexDir, "repo_v16.00000.zoekt.crashed.tmp");
    const freshTemp = path.join(indexDir, "repo_v16.00000.zoekt.active.tmp");
    const oldRustTemp = path.join(indexDir, ".tmpABC123");
    const freshRustTemp = path.join(indexDir, ".tmpXYZ789");
    const unrelatedDotTemp = path.join(indexDir, ".tmp-not-owned");
    await writeFile(oldTemp, "old temporary\n");
    await writeFile(freshTemp, "fresh temporary\n");
    await writeFile(oldRustTemp, "old Rust temporary\n");
    await writeFile(freshRustTemp, "fresh Rust temporary\n");
    await writeFile(unrelatedDotTemp, "unrelated\n");
    const nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    await utimes(oldTemp, new Date(nowMs - 2 * 60 * 60 * 1_000), new Date(nowMs - 2 * 60 * 60 * 1_000));
    await utimes(freshTemp, new Date(nowMs), new Date(nowMs));
    await utimes(oldRustTemp, new Date(nowMs - 2 * 60 * 60 * 1_000), new Date(nowMs - 2 * 60 * 60 * 1_000));
    await utimes(freshRustTemp, new Date(nowMs), new Date(nowMs));

    const preserved = [
      "github.com%2Fexample%2Frepo_v16.00000.zoekt",
      "github.com%2Fexample%2Frepo_v16.00000.zoekt.meta",
      "compound-00001.zoekt",
      "fast-grep-overlay-invalid!_v16.00000.zoekt",
      `${sourcePrefix}_v16.00000.zoekt.bak`,
    ];
    for (const file of preserved) await writeFile(path.join(indexDir, file), "base\n");

    const result = await vacuumOwnedIndexArtifacts(indexDir, {
      nowMs,
      staleTempMinAgeMs: 60 * 60 * 1_000,
    });

    for (const file of [...removed, "overlay-source"]) {
      await expect(exists(path.join(indexDir, file))).resolves.toBe(false);
    }
    await expect(exists(oldTemp)).resolves.toBe(false);
    await expect(exists(oldRustTemp)).resolves.toBe(false);
    await expect(exists(freshTemp)).resolves.toBe(true);
    await expect(exists(freshRustTemp)).resolves.toBe(true);
    await expect(exists(unrelatedDotTemp)).resolves.toBe(true);
    for (const file of preserved) {
      await expect(exists(path.join(indexDir, file))).resolves.toBe(true);
    }
    expect(result.removedFiles).toBeGreaterThanOrEqual(removed.length + 2);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.completedAt).toBe("2026-07-23T00:00:00.000Z");
  });

  test("kernel-only vacuum removes Rust NamedTempFile leftovers without overlay cleanup", async () => {
    const root = await temporaryRoot("pi-fast-grep-kernel-vacuum-");
    const indexDir = path.join(root, "index");
    await mkdir(path.join(indexDir, "overlay-source"), { recursive: true });
    const stale = path.join(indexDir, ".tmpK3RN3L");
    await writeFile(stale, "crashed kernel generation\n");
    const nowMs = Date.parse("2026-08-19T00:00:00.000Z");
    await utimes(stale, new Date(nowMs - 2 * 60 * 60 * 1_000), new Date(nowMs - 2 * 60 * 60 * 1_000));

    const result = await vacuumStaleIndexTemporaries(indexDir, {
      nowMs,
      staleTempMinAgeMs: 60 * 60 * 1_000,
    });

    await expect(exists(stale)).resolves.toBe(false);
    await expect(exists(path.join(indexDir, "overlay-source"))).resolves.toBe(true);
    expect(result.removedFiles).toBe(1);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
  });
});
