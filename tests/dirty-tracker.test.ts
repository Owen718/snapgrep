import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DirtyCoverageError, DirtyTracker } from "../src/dirty-tracker.js";
import type { CommandResult } from "../src/process.js";

function commandResult(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "", durationMs: 0 };
}

describe("DirtyTracker generation safety", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-dirty-"));
    roots.push(root);
    return root;
  }

  test("increments generation for every repeated path and unknown-workspace event", async () => {
    const tracker = new DirtyTracker(await createRoot(), {
      runCommand: async () => commandResult(),
    });

    const initial = await tracker.snapshot();
    tracker.markRelative("src/repeated.ts");
    const first = await tracker.snapshot();
    tracker.markRelative("src/repeated.ts");
    const repeated = await tracker.snapshot();

    expect(first.generation).toBe(initial.generation + 1);
    expect(repeated.generation).toBe(first.generation + 1);
    expect([...repeated.paths]).toEqual(["src/repeated.ts"]);

    tracker.markWorkspaceUnknown();
    const unknown = await tracker.snapshot();
    tracker.markToolPath(undefined);
    const missingToolPath = await tracker.snapshot();
    expect(unknown.generation).toBe(repeated.generation + 1);
    expect(missingToolPath.generation).toBe(unknown.generation + 1);
  });

  test("preserves valid dot-dot, at-sign, and whitespace tool path names", async () => {
    const tracker = new DirtyTracker(await createRoot(), {
      runCommand: async () => commandResult(),
    });

    tracker.markToolPath("..foo.ts");
    tracker.markToolPath("@scope.ts");
    tracker.markToolPath(" spaced.ts ");
    expect([...(await tracker.snapshot()).paths]).toEqual([
      "..foo.ts",
      "@scope.ts",
      " spaced.ts ",
    ]);
  });

  test("replace refresh preserves events that arrive while git status is in flight", async () => {
    let releaseStatus: ((result: CommandResult) => void) | undefined;
    const tracker = new DirtyTracker(await createRoot(), {
      runCommand: async () =>
        await new Promise<CommandResult>((resolve) => {
          releaseStatus = resolve;
        }),
    });
    tracker.markRelative("src/stale-before-scan.ts");
    tracker.markRelative("src/repeated-during-scan.ts");

    const refresh = tracker.refreshFromGit(true);
    expect(releaseStatus).toBeTypeOf("function");
    tracker.markRelative("src/repeated-during-scan.ts");
    tracker.markRelative("src/during-scan.ts");
    releaseStatus?.(commandResult());
    await refresh;

    const snapshot = await tracker.snapshot();
    expect([...snapshot.paths]).toEqual(["src/repeated-during-scan.ts", "src/during-scan.ts"]);
  });

  test("acknowledging an old snapshot cannot clear a newer event for the same path", async () => {
    const tracker = new DirtyTracker(await createRoot(), {
      runCommand: async () => commandResult(),
    });
    tracker.markRelative("src/raced.ts");
    tracker.markRelative("src/other.ts");
    const indexedSnapshot = await tracker.snapshot();

    tracker.markRelative("src/raced.ts");
    expect(tracker.acknowledgeIndexedPaths(indexedSnapshot.paths, indexedSnapshot.generation)).toBe(1);

    const afterOldAcknowledgement = await tracker.snapshot();
    expect([...afterOldAcknowledgement.paths]).toEqual(["src/raced.ts"]);
    expect(afterOldAcknowledgement.generation).toBeGreaterThan(indexedSnapshot.generation);

    expect(
      tracker.acknowledgeIndexedPaths(
        afterOldAcknowledgement.paths,
        afterOldAcknowledgement.generation,
      ),
    ).toBe(1);
    expect((await tracker.snapshot()).paths.size).toBe(0);
  });

  test("keeps the default startup git status scan unchanged", async () => {
    const calls: string[][] = [];
    const tracker = new DirtyTracker(await createRoot(), {
      runCommand: async (_command, args) => {
        calls.push([...args]);
        return commandResult(" M src/default-dirty.ts\0");
      },
    });

    try {
      await tracker.start();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("status");
      expect([...(await tracker.snapshot()).paths]).toEqual(["src/default-dirty.ts"]);
    } finally {
      tracker.stop();
    }
  });

  test("does not treat a failed default git status as clean coverage", async () => {
    let calls = 0;
    const tracker = new DirtyTracker(await createRoot(), {
      runCommand: async () => {
        calls += 1;
        throw new Error("git status unavailable");
      },
    });

    try {
      await tracker.start();
      expect(calls).toBe(1);
      await expect(tracker.snapshot()).rejects.toBeInstanceOf(DirtyCoverageError);
      expect(calls).toBe(2);
    } finally {
      tracker.stop();
    }
  });

  test("preserves a watcher event that arrives during the default startup scan", async () => {
    let watcherListener:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    let releaseStatus: ((result: CommandResult) => void) | undefined;
    const fakeWatcher = Object.assign(new EventEmitter(), { close: () => undefined }) as FSWatcher;
    const tracker = new DirtyTracker(await createRoot(), {
      watchFactory: (_root, listener) => {
        watcherListener = listener;
        return fakeWatcher;
      },
      runCommand: async () =>
        await new Promise<CommandResult>((resolve) => {
          releaseStatus = resolve;
        }),
    });

    try {
      const start = tracker.start();
      expect(watcherListener).toBeTypeOf("function");
      expect(releaseStatus).toBeTypeOf("function");
      watcherListener?.("change", "src/during-start.ts");
      releaseStatus?.(commandResult());
      await start;

      expect([...(await tracker.snapshot()).paths]).toEqual(["src/during-start.ts"]);
    } finally {
      tracker.stop();
    }
  });

  test("marks only HEAD-relevant watcher events as commit-cache invalidations", async () => {
    let watcherListener:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const fakeWatcher = Object.assign(new EventEmitter(), { close: () => undefined }) as FSWatcher;
    const tracker = new DirtyTracker(await createRoot(), {
      initialDirtyPaths: [],
      watchFactory: (_root, listener) => {
        watcherListener = listener;
        return fakeWatcher;
      },
      runCommand: async () => commandResult(),
    });
    const notifications: Array<{ generation: number; headMayHaveChanged: boolean }> = [];
    const unsubscribe = tracker.onDirty((generation, headMayHaveChanged) => {
      notifications.push({ generation, headMayHaveChanged });
    });

    try {
      await tracker.start();
      watcherListener?.("change", "src/ordinary.ts");
      watcherListener?.("rename", ".git/refs/heads/main");

      expect(notifications).toEqual([
        { generation: 1, headMayHaveChanged: false },
        { generation: 2, headMayHaveChanged: true },
      ]);
      await tracker.snapshot();
      expect([...(await tracker.snapshot()).paths]).toEqual(["src/ordinary.ts"]);
    } finally {
      unsubscribe();
      tracker.stop();
    }
  });

  test("an explicit empty snapshot skips only the first startup git status", async () => {
    const calls: string[][] = [];
    const tracker = new DirtyTracker(await createRoot(), {
      initialDirtyPaths: [],
      runCommand: async (_command, args) => {
        calls.push([...args]);
        return commandResult();
      },
    });

    try {
      await tracker.start();
      expect(calls).toEqual([]);
      expect((await tracker.snapshot()).paths.size).toBe(0);

      tracker.markToolPath("src/tool-change.ts");
      expect([...(await tracker.snapshot()).paths]).toEqual(["src/tool-change.ts"]);
      expect(calls).toEqual([]);

      tracker.markWorkspaceUnknown();
      await tracker.snapshot();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("status");

      tracker.stop();
      await tracker.start();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("status");
    } finally {
      tracker.stop();
    }
  });

  test("normalizes and seeds a trusted dirty snapshot without claiming a git repository", async () => {
    const root = await createRoot();
    const calls: string[][] = [];
    const tracker = new DirtyTracker(root, {
      initialDirtyPaths: [
        "./src/dirty.ts",
        "src/nested/../dirty.ts",
        "deleted.ts",
        ".git/index",
      ],
      runCommand: async (_command, args) => {
        calls.push([...args]);
        if (args.includes("rev-parse")) return commandResult("trusted-commit\n");
        return commandResult();
      },
    });

    try {
      await tracker.start();
      const seeded = await tracker.snapshot();
      expect([...seeded.paths].sort()).toEqual(["deleted.ts", "src/dirty.ts"]);
      expect([...seeded.tombstones].sort()).toEqual(["deleted.ts", "src/dirty.ts"]);
      expect(calls).toEqual([]);

      // Until a real status succeeds, commit acknowledgement must not treat the
      // trusted snapshot as Git-derived or clear it.
      await tracker.acknowledgeIndexedCommit("trusted-commit");
      expect(calls).toEqual([]);
      expect([...(await tracker.snapshot()).paths].sort()).toEqual(["deleted.ts", "src/dirty.ts"]);

      tracker.markWorkspaceUnknown();
      await tracker.snapshot();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("status");

      await tracker.acknowledgeIndexedCommit("trusted-commit");
      expect(calls).toHaveLength(3);
      expect(calls[1]).toContain("rev-parse");
      expect(calls[2]).toContain("status");
      expect((await tracker.snapshot()).paths.size).toBe(0);
    } finally {
      tracker.stop();
    }
  });

  test("a watcher error after trusted seeding triggers a conservative git repair", async () => {
    const calls: string[][] = [];
    const fakeWatcher = Object.assign(new EventEmitter(), { close: () => undefined }) as FSWatcher;
    const tracker = new DirtyTracker(await createRoot(), {
      initialDirtyPaths: [],
      watchFactory: () => fakeWatcher,
      runCommand: async (_command, args) => {
        calls.push([...args]);
        return commandResult(" M src/repaired.ts\0");
      },
    });

    try {
      await tracker.start();
      expect(calls).toEqual([]);
      fakeWatcher.emit("error", new Error("watcher failed"));

      await expect(tracker.snapshot()).rejects.toBeInstanceOf(DirtyCoverageError);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("status");
    } finally {
      tracker.stop();
    }
  });

  test("a watcher creation failure cannot make a trusted seed suppress git repair", async () => {
    const calls: string[][] = [];
    const tracker = new DirtyTracker(await createRoot(), {
      initialDirtyPaths: ["src/seeded.ts"],
      watchFactory: () => {
        throw new Error("watch creation failed");
      },
      runCommand: async (_command, args) => {
        calls.push([...args]);
        return commandResult(" M src/repaired.ts\0");
      },
    });

    try {
      await tracker.start();
      expect(calls).toEqual([]);

      await expect(tracker.snapshot()).rejects.toBeInstanceOf(DirtyCoverageError);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("status");
    } finally {
      tracker.stop();
    }
  });

  test("unknown coverage stays fail-loud when its repair status fails", async () => {
    let calls = 0;
    const tracker = new DirtyTracker(await createRoot(), {
      initialDirtyPaths: [],
      runCommand: async () => {
        calls += 1;
        throw new Error("git repair failed");
      },
    });

    try {
      await tracker.start();
      tracker.markWorkspaceUnknown();

      await expect(tracker.snapshot()).rejects.toBeInstanceOf(DirtyCoverageError);
      expect(calls).toBe(1);
    } finally {
      tracker.stop();
    }
  });
});
