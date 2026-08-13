import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

type TestMock = ReturnType<typeof vi.fn>;

interface FastEngineDouble {
  options: Record<string, unknown>;
  start: TestMock;
  stop: TestMock;
  search: TestMock;
}

interface FffEngineDouble {
  root: string;
  start: TestMock;
  stop: TestMock;
  search: TestMock;
  markWorkspaceChanged: TestMock;
}

const engineDoubles = vi.hoisted(() => ({
  fast: [] as FastEngineDouble[],
  fff: [] as FffEngineDouble[],
}));

vi.mock("../src/engine.js", () => ({
  FastGrepEngine: class {
    readonly options: Record<string, unknown>;
    readonly start = vi.fn(async () => undefined);
    readonly stop = vi.fn(async () => undefined);
    readonly search = vi.fn(
      async (
        _request: unknown,
        options: { backend: "auto" | "instant" | "normal" },
      ) => ({
        matches: [],
        metadata: {
          requestedBackend: options.backend,
          actualBackend: options.backend === "normal" ? "rg" : "zoekt",
          dirtyFiles: 0,
          realtimeFiles: 0,
          totalMatches: 0,
          totalMatchesExact: true,
          displayedMatches: 0,
          truncated: false,
          timings: { totalMs: 3 },
        },
      }),
    );
    readonly markToolPath = vi.fn();
    readonly markWorkspaceUnknown = vi.fn();
    readonly indexManager = { refreshInBackground: vi.fn() };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      engineDoubles.fast.push(this);
    }
  },
}));

vi.mock("../src/fff-engine.js", () => ({
  FffEngine: class {
    readonly root: string;
    readonly start = vi.fn(async () => undefined);
    readonly stop = vi.fn();
    readonly markWorkspaceChanged = vi.fn();
    readonly search = vi.fn(async () => ({
      matches: [],
      metadata: {
        requestedBackend: "fff",
        actualBackend: "fff",
        indexFilesConsidered: 7,
        indexFilesLoaded: 2,
        indexMatchCount: 1,
        dirtyFiles: 0,
        realtimeFiles: 0,
        totalMatches: 0,
        totalMatchesExact: true,
        displayedMatches: 0,
        truncated: false,
        timings: { totalMs: 5, indexQueryMs: 1, verifyMs: 4 },
      },
    }));

    constructor(root: string) {
      this.root = root;
      engineDoubles.fff.push(this);
    }
  },
}));

import fastGrepExtension from "../src/extension.js";

type Handler = (...args: never[]) => unknown;

function extensionHarness(initialBackend: string) {
  const flags = new Map<string, boolean | string | undefined>([
    ["fast-grep-backend", initialBackend],
  ]);
  const handlers = new Map<string, Handler>();
  const tools: Array<Record<string, unknown>> = [];
  const api = {
    registerFlag: () => undefined,
    registerTool: (tool: unknown) => tools.push(tool as Record<string, unknown>),
    getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  fastGrepExtension(api);
  return { flags, handlers, tools };
}

function handler(
  handlers: ReadonlyMap<string, Handler>,
  name: string,
): (...args: unknown[]) => unknown {
  const registered = handlers.get(name);
  if (registered === undefined) throw new Error(`missing ${name} handler`);
  return registered as (...args: unknown[]) => unknown;
}

function fakeContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

describe("FFF extension backend", () => {
  beforeEach(() => {
    engineDoubles.fast.length = 0;
    engineDoubles.fff.length = 0;
  });

  test("routes fff through FffEngine and applies the common formatter timing boundary", async () => {
    const root = "/tmp/pi-fast-grep-fff-extension";
    const harness = extensionHarness("fff");
    const ctx = fakeContext(root);

    await handler(harness.handlers, "session_start")({}, ctx);

    expect(engineDoubles.fast).toHaveLength(0);
    expect(engineDoubles.fff).toHaveLength(1);
    const fff = engineDoubles.fff[0]!;
    expect(fff.root).toBe(root);
    expect(fff.start).toHaveBeenCalledOnce();

    const execute = harness.tools[0]?.execute as
      | ((...args: unknown[]) => Promise<Record<string, unknown>>)
      | undefined;
    if (execute === undefined) throw new Error("grep tool was not registered");
    const output = await execute(
      "grep-call",
      { pattern: "needle", context: 0, limit: 10 },
      undefined,
      undefined,
      ctx,
    );

    expect(fff.search).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "needle", context: 0, limit: 10 }),
      {},
    );
    const details = output.details as {
      metadata: {
        requestedBackend: string;
        actualBackend: string;
        timings: { totalMs: number; formatMs?: number };
      };
    };
    expect(details.metadata.requestedBackend).toBe("fff");
    expect(details.metadata.actualBackend).toBe("fff");
    expect(details.metadata.timings.formatMs).toEqual(expect.any(Number));
    expect(details.metadata.timings.totalMs).toBeGreaterThanOrEqual(5);
  });

  test("invalidates FFF path eligibility after write, edit, or unknown bash changes", async () => {
    const harness = extensionHarness("fff");
    const ctx = fakeContext("/tmp/pi-fast-grep-fff-freshness");
    await handler(harness.handlers, "session_start")({}, ctx);
    const fff = engineDoubles.fff[0]!;
    const toolResult = handler(harness.handlers, "tool_result");

    toolResult({ toolName: "write", input: { path: "src/new.ts" } }, ctx);
    toolResult({ toolName: "edit", input: { path: "src/changed.ts" } }, ctx);
    toolResult({ toolName: "bash", input: { command: "touch src/bash.ts" } }, ctx);

    expect(fff.markWorkspaceChanged).toHaveBeenCalledTimes(3);
  });

  test("stops FFF when switching backend and shuts down the active FastGrepEngine", async () => {
    const harness = extensionHarness("fff");
    const ctx = fakeContext("/tmp/pi-fast-grep-fff-lifecycle");
    await handler(harness.handlers, "session_start")({}, ctx);
    const fff = engineDoubles.fff[0]!;

    harness.flags.set("fast-grep-backend", "normal");
    const execute = harness.tools[0]?.execute as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    if (execute === undefined) throw new Error("grep tool was not registered");
    await execute("grep-call", { pattern: "needle" }, undefined, undefined, ctx);

    expect(fff.stop).toHaveBeenCalledOnce();
    expect(engineDoubles.fast).toHaveLength(1);
    const fast = engineDoubles.fast[0]!;
    expect(fast.start).toHaveBeenCalledWith({ waitForIndex: false });
    expect(fast.search).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ backend: "normal" }),
    );

    await handler(harness.handlers, "session_shutdown")();

    expect(fast.stop).toHaveBeenCalledOnce();
    expect(fff.stop).toHaveBeenCalledOnce();
  });
});
