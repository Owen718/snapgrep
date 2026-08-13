import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DirtyTracker } from "../src/dirty-tracker.js";
import { FastGrepEngine } from "../src/engine.js";
import {
  type CurrentCommitSnapshot,
  IndexManager,
  type IndexManagerOptions,
  type IndexStatus,
} from "../src/index-manager.js";

class ReadyIndexManager extends IndexManager {
  private readonly readyUrl: string;
  private commitGeneration = 0;
  private commitKnown = true;

  constructor(options: IndexManagerOptions, readyUrl = "http://127.0.0.1:1") {
    super(options);
    this.readyUrl = readyUrl;
  }

  override get ready(): boolean {
    return true;
  }

  override get url(): string {
    return this.readyUrl;
  }

  override status(): IndexStatus {
    return {
      lifecycle: "ready",
      mode: "git",
      root: this.root,
      indexDir: this.indexDir,
      indexedCommit: "trusted-commit",
      submodulesPresent: false,
    };
  }

  override start(): Promise<void> {
    return Promise.resolve();
  }

  override currentCommit(): Promise<string> {
    this.commitKnown = true;
    return Promise.resolve("trusted-commit");
  }

  override currentCommitSnapshot(): CurrentCommitSnapshot {
    return {
      generation: this.commitGeneration,
      known: this.commitKnown,
      ...(this.commitKnown ? { commit: "trusted-commit" } : {}),
    };
  }

  override invalidateCurrentCommit(): void {
    this.commitGeneration += 1;
    this.commitKnown = false;
  }

  override stop(): Promise<void> {
    return Promise.resolve();
  }
}

describe("FastGrepEngine initial dirty snapshot wiring", () => {
  const roots: string[] = [];
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("passes an explicit trusted snapshot to its DirtyTracker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-engine-dirty-"));
    roots.push(root);
    const engine = new FastGrepEngine({
      root,
      initialDirtyPaths: ["src/seeded.ts"],
    });

    try {
      await engine.dirtyTracker.start();
      expect([...(await engine.dirtyTracker.snapshot()).paths]).toEqual(["src/seeded.ts"]);
    } finally {
      engine.dirtyTracker.stop();
    }
  });

  test("falls back to whole-tree ripgrep when initial dirty coverage cannot be established", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-engine-untrusted-"));
    roots.push(root);
    await writeFile(path.join(root, "probe.ts"), "FG_UNTRUSTED_COVERAGE\n");
    const tracker = new DirtyTracker(root, {
      runCommand: async () => {
        throw new Error("git status unavailable");
      },
    });
    const engine = new FastGrepEngine({
      root,
      dirtyTracker: tracker,
      indexManager: new ReadyIndexManager({ root }),
    });

    try {
      const result = await engine.search(
        { pattern: "FG_UNTRUSTED_COVERAGE", literal: true, context: 0, limit: null },
        { backend: "instant" },
      );
      expect(result.metadata.actualBackend).toBe("rg_fallback");
      expect(result.metadata.fallbackReason).toContain("workspace dirty coverage unavailable");
      expect(result.matches.map((match) => match.path)).toEqual(["probe.ts"]);
    } finally {
      await engine.stop();
    }
  });

  test("falls back when an unknown-workspace repair status fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-engine-repair-"));
    roots.push(root);
    await writeFile(path.join(root, "probe.ts"), "FG_FAILED_REPAIR\n");
    const tracker = new DirtyTracker(root, {
      initialDirtyPaths: [],
      runCommand: async () => {
        throw new Error("git repair unavailable");
      },
    });
    const engine = new FastGrepEngine({
      root,
      dirtyTracker: tracker,
      indexManager: new ReadyIndexManager({ root }),
    });

    try {
      await engine.start();
      tracker.markWorkspaceUnknown();
      const result = await engine.search(
        { pattern: "FG_FAILED_REPAIR", literal: true, context: 0, limit: null },
        { backend: "instant" },
      );
      expect(result.metadata.actualBackend).toBe("rg_fallback");
      expect(result.metadata.fallbackReason).toContain("workspace dirty coverage unavailable");
      expect(result.matches.map((match) => match.path)).toEqual(["probe.ts"]);
    } finally {
      await engine.stop();
    }
  });

  test("falls back if coverage becomes untrusted during an indexed query", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-engine-query-race-"));
    roots.push(root);
    await writeFile(path.join(root, "probe.ts"), "FG_QUERY_COVERAGE_RACE\n");
    const tracker = new DirtyTracker(root, {
      initialDirtyPaths: [],
      runCommand: async () => {
        throw new Error("git repair unavailable");
      },
    });
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) tracker.markWorkspaceUnknown();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        Result: {
          FilesConsidered: 0,
          FilesLoaded: 0,
          MatchCount: 0,
          Duration: 0,
          Files: [],
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const engine = new FastGrepEngine({
      root,
      dirtyTracker: tracker,
      indexManager: new ReadyIndexManager(
        { root },
        `http://127.0.0.1:${address.port}`,
      ),
    });

    try {
      const result = await engine.search(
        { pattern: "FG_QUERY_COVERAGE_RACE", literal: true, context: 0, limit: null },
        { backend: "instant" },
      );
      expect(requests).toBeGreaterThan(0);
      expect(result.metadata.actualBackend).toBe("rg_fallback");
      expect(result.metadata.fallbackReason).toMatch(
        /repository commit changed|workspace dirty coverage unavailable/u,
      );
      expect(result.matches.map((match) => match.path)).toEqual(["probe.ts"]);
    } finally {
      await engine.stop();
    }
  });
});
