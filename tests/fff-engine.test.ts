import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileFinder } from "@ff-labs/fff-node";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FffEngine,
  FffUnsupportedQueryError,
  planFffQuery,
} from "../src/fff-engine.js";
import { runRipgrep } from "../src/rg.js";
import type { SearchRequest, SearchResult } from "../src/types.js";

const fixture = path.resolve("benchmarks/fixtures/core");
const temporaryRoots: string[] = [];

async function fixtureCopy(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-fff-test-"));
  temporaryRoots.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function occurrences(result: SearchResult): string[] {
  return result.matches.flatMap((match) =>
    match.ranges.map((range) => `${match.path}:${range.absoluteStart}:${range.absoluteEnd}`),
  );
}

describe("planFffQuery", () => {
  test("passes a literal directly to FFF's native plain mode", () => {
    expect(planFffQuery({ pattern: "FG_RARE_TOKEN", literal: true })).toEqual({
      eligible: true,
      query: "FG_RARE_TOKEN",
      mode: "plain",
    });
  });

  test("encodes path and glob through FFF's native query constraints", () => {
    expect(planFffQuery(
      {
        pattern: "registerCommand",
        literal: true,
        path: "src/vs/workbench",
        glob: "**/*.ts",
      },
      "/repo",
    )).toEqual({
      eligible: true,
      query: "src/vs/workbench/ **/*.ts registerCommand",
      mode: "plain",
    });
  });

  test("does not repair noIgnore or Unicode differences in the query planner", () => {
    expect(planFffQuery({
      pattern: String.raw`name.\w+`,
      noIgnore: true,
    })).toEqual({
      eligible: true,
      query: String.raw`name.\w+`,
      mode: "regex",
    });
  });

  test("reports requests that native line-oriented grep cannot represent", () => {
    expect(planFffQuery({ pattern: "token", multiline: true })).toMatchObject({
      eligible: false,
    });
    expect(planFffQuery({ pattern: "a\nb" })).toMatchObject({
      eligible: false,
    });
    expect(planFffQuery({
      pattern: "token",
      literal: true,
      path: "/outside/repo",
    }, "/repo")).toMatchObject({
      eligible: false,
    });
  });
});

describe("FffEngine native opponent adapter", () => {
  test("uses the factory defaults and waits only for the initial scan", async () => {
    const root = await fixtureCopy();
    const originalCreate = FileFinder.create;
    const createSpy = vi.spyOn(FileFinder, "create").mockImplementation((options) =>
      originalCreate.call(FileFinder, options)
    );
    const engine = new FffEngine(root);
    try {
      const status = await engine.start({ timeoutMs: 10_000 });
      expect(status.ready).toBe(true);
      expect(status.indexedFiles).toBeGreaterThan(0);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith({ basePath: root });
    } finally {
      engine.stop();
    }
  });

  test("normalizes FFF's native byte ranges without rg verification", async () => {
    const root = await fixtureCopy();
    const engine = new FffEngine(root);
    try {
      const request: SearchRequest = {
        pattern: "FG_RARE_TOKEN",
        literal: true,
        hidden: true,
        context: 0,
        limit: null,
      };
      const normal = await runRipgrep(root, request, {
        actualBackend: "rg",
        requestedBackend: "normal",
      });
      const native = await engine.search(request);

      expect(native.metadata.actualBackend).toBe("fff");
      expect(native.metadata.timings.verifyMs).toBeUndefined();
      expect(native.metadata.totalMatchesExact).toBe(true);
      expect(occurrences(native)).toEqual(occurrences(normal));
      expect(native.matches.every((match) =>
        match.ranges.every((range) => range.absoluteEnd > range.absoluteStart)
      )).toBe(true);
    } finally {
      engine.stop();
    }
  });

  test("preserves FFF's nested-gitignore recall gap instead of filling it with rg", async () => {
    const root = await fixtureCopy();
    const token = "FFF_NESTED_REINCLUSION_TOKEN";
    await mkdir(path.join(root, "nested-ignore", "lib"), { recursive: true });
    await writeFile(
      path.join(root, "nested-ignore", ".gitignore"),
      "*\n!/**/\n!*.c\n!.gitignore\n",
    );
    await writeFile(path.join(root, "nested-ignore", "top.c"), `${token}\n`);
    await writeFile(path.join(root, "nested-ignore", "lib", "deep.c"), `${token}\n`);

    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      const request: SearchRequest = {
        pattern: token,
        literal: true,
        hidden: true,
        context: 0,
        limit: null,
      };
      const normal = await runRipgrep(root, request, {
        actualBackend: "rg",
        requestedBackend: "normal",
      });
      const native = await engine.search(request);

      expect(occurrences(normal)).toHaveLength(2);
      expect(occurrences(native)).toEqual([
        `nested-ignore/top.c:0:${Buffer.byteLength(token)}`,
      ]);
      expect(native.metadata.actualBackend).toBe("fff");
    } finally {
      engine.stop();
    }
  });

  test("preserves FFF's native 10 MiB content-search limit", async () => {
    const root = await fixtureCopy();
    const token = "FFF_OVERSIZED_FILE_TOKEN";
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x0a);
    oversized.write(token, 0, "utf8");
    await writeFile(path.join(root, "oversized.c"), oversized);

    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      const request: SearchRequest = {
        pattern: token,
        literal: true,
        hidden: true,
        context: 0,
        limit: null,
      };
      const normal = await runRipgrep(root, request, {
        actualBackend: "rg",
        requestedBackend: "normal",
      });
      const native = await engine.search(request);

      expect(occurrences(normal)).toHaveLength(1);
      expect(native.matches).toHaveLength(0);
      expect(native.metadata.actualBackend).toBe("fff");
    } finally {
      engine.stop();
    }
  });

  test("preserves FFF's static binary-suffix exclusion", async () => {
    const root = await fixtureCopy();
    const relativePath = "scripts/Makefile.lib";
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, relativePath),
      "CONFIG_FFF_STATIC_BINARY_FALSE_POSITIVE=y\n",
    );

    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      const request: SearchRequest = {
        pattern: "CONFIG_[A-Z][A-Z0-9_]+",
        hidden: true,
        context: 0,
        limit: null,
      };
      const normal = await runRipgrep(root, request, {
        actualBackend: "rg",
        requestedBackend: "normal",
      });
      const native = await engine.search(request);

      expect(occurrences(normal)).toHaveLength(1);
      expect(native.matches).toHaveLength(0);
      expect(native.metadata.actualBackend).toBe("fff");
    } finally {
      engine.stop();
    }
  });

  test("does not turn explicit binary files into an rg repair path", async () => {
    const root = await fixtureCopy();
    const relativePath = "early-match.bin";
    const token = "FFF_BINARY_BEFORE_NUL_TOKEN";
    await writeFile(
      path.join(root, relativePath),
      Buffer.concat([
        Buffer.from(token),
        Buffer.from([0]),
        Buffer.from("tail\n"),
      ]),
    );

    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      const request: SearchRequest = {
        pattern: token,
        literal: true,
        path: relativePath,
        hidden: true,
        context: 0,
        limit: null,
      };
      const normal = await runRipgrep(root, request, {
        actualBackend: "rg",
        requestedBackend: "normal",
      });
      const native = await engine.search(request);

      expect(occurrences(normal)).toHaveLength(1);
      expect(native.matches).toHaveLength(0);
      expect(native.metadata.actualBackend).toBe("fff");
    } finally {
      engine.stop();
    }
  });

  test("does not probe or reconcile a late-NUL binary file", async () => {
    const root = await fixtureCopy();
    const relativePath = "late-nul.pb";
    const token = "FFF_LATE_BINARY_BEFORE_NUL_TOKEN";
    await writeFile(
      path.join(root, relativePath),
      Buffer.concat([
        Buffer.from(`${token}\n`),
        Buffer.alloc(128 * 1024, 0x61),
        Buffer.from([0]),
        Buffer.from("tail\n"),
      ]),
    );

    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      const request: SearchRequest = {
        pattern: token,
        literal: true,
        hidden: true,
        context: 0,
        limit: null,
      };
      const normal = await runRipgrep(root, request, {
        actualBackend: "rg",
        requestedBackend: "normal",
      });
      const native = await engine.search(request);

      expect(occurrences(normal)).toHaveLength(1);
      expect(native.matches).toHaveLength(0);
      expect(native.metadata.actualBackend).toBe("fff");
    } finally {
      engine.stop();
    }
  });

  test("stops at the requested native page boundary without hiding truncation", async () => {
    const root = await fixtureCopy();
    const token = "FFF_NATIVE_LIMIT_TOKEN";
    await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        await writeFile(
          path.join(root, `native-limit-${String(index).padStart(2, "0")}.ts`),
          `${token}\n`,
        );
      }),
    );

    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      const grepSpy = vi.spyOn(FileFinder.prototype, "grep");
      const native = await engine.search({
        pattern: token,
        literal: true,
        hidden: true,
        context: 0,
        limit: 25,
      });

      expect(native.matches).toHaveLength(25);
      expect(native.metadata.truncated).toBe(true);
      expect(native.metadata.totalMatchesExact).toBe(false);
      expect(grepSpy).toHaveBeenCalledTimes(1);
    } finally {
      engine.stop();
    }
  });

  test("reports native regex-to-literal fallback as unsupported", async () => {
    const root = await fixtureCopy();
    const engine = new FffEngine(root);
    try {
      await engine.start({ timeoutMs: 10_000 });
      await expect(engine.search({
        pattern: "(?<=",
        hidden: true,
        context: 0,
        limit: null,
      })).rejects.toBeInstanceOf(FffUnsupportedQueryError);
    } finally {
      engine.stop();
    }
  });

  test("observes native watcher updates without wrapper invalidation", async () => {
    const root = await fixtureCopy();
    const engine = new FffEngine(root);
    const token = "FFF_WATCHER_FRESH_TOKEN";
    try {
      await engine.start({ timeoutMs: 10_000 });
      await writeFile(path.join(root, "fff-watcher.ts"), `${token}\n`);
      let observed = false;
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        const result = await engine.search({
          pattern: token,
          literal: true,
          hidden: true,
          context: 0,
          limit: null,
        });
        if (result.matches.length > 0) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true);
    } finally {
      engine.stop();
    }
  });
});
