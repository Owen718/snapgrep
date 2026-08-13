import type {
  ExtensionAPI,
  ExtensionContext,
  ToolExecutionStartEvent,
  ToolResultEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

type TestMock = ReturnType<typeof vi.fn>;

interface FeedDouble {
  marked: boolean;
  reason: string | undefined;
  mark: TestMock;
  subscribe(listener: (reason: string) => void): () => void;
}

interface KernelDouble {
  options: {
    root: string;
    addonPath: string;
    trustedMutationFeed: FeedDouble;
    sessionWorktreeSnapshot?: boolean;
  };
  start: TestMock;
  close: TestMock;
  search: TestMock;
  markWorkspaceChanged: TestMock;
}

interface FastDouble {
  options: Record<string, unknown>;
  start: TestMock;
  stop: TestMock;
  search: TestMock;
}

const doubles = vi.hoisted(() => ({
  feeds: [] as FeedDouble[],
  kernels: [] as KernelDouble[],
  fast: [] as FastDouble[],
  failNextKernelStart: false,
  searchBarrier: undefined as Promise<void> | undefined,
}));

vi.mock("../src/kernel-engine.js", () => ({
  KernelMutationFeed: class {
    private firstReason: string | undefined;
    private readonly listeners = new Set<(reason: string) => void>();
    readonly mark = vi.fn((reason = "kernel_host_mutation") => {
      const firstReason = this.firstReason ?? reason;
      this.firstReason = firstReason;
      for (const listener of this.listeners) listener(firstReason);
    });

    constructor() {
      doubles.feeds.push(this as unknown as FeedDouble);
    }

    get marked(): boolean {
      return this.firstReason !== undefined;
    }

    get reason(): string | undefined {
      return this.firstReason;
    }

    subscribe(listener: (reason: string) => void): () => void {
      this.listeners.add(listener);
      if (this.firstReason !== undefined) listener(this.firstReason);
      return () => this.listeners.delete(listener);
    }
  },
  OptInKernelEngine: class {
    readonly options: KernelDouble["options"];
    private invalidReason: string | undefined;
    private unsubscribe: (() => void) | undefined;
    readonly markWorkspaceChanged = vi.fn((reason = "workspace_changed") => {
      this.invalidReason ??= reason;
    });
    readonly start = vi.fn(async () => {
      if (this.options.trustedMutationFeed.marked) {
        this.invalidReason =
          this.options.trustedMutationFeed.reason ?? "kernel_start_failed";
        throw new Error("synthetic pre-marked mutation feed");
      }
      this.unsubscribe = this.options.trustedMutationFeed.subscribe((reason) => {
        this.markWorkspaceChanged(reason);
      });
      if (doubles.failNextKernelStart) {
        doubles.failNextKernelStart = false;
        this.invalidReason = "kernel_start_failed";
        throw new Error("synthetic native start failure");
      }
    });
    readonly close = vi.fn(() => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.invalidReason ??= "kernel_closed";
      return true;
    });
    readonly search = vi.fn(async () => {
      await doubles.searchBarrier;
      const fallbackReason = this.invalidReason
        ?? this.options.trustedMutationFeed.reason;
      const actualBackend =
        fallbackReason === undefined ? "kernel" : "rg_fallback";
      return {
        matches: [],
        metadata: {
          requestedBackend: "kernel-dev",
          actualBackend,
          kernelFreshnessMode: "agent_loop_serialized_v1",
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
          indexFilesConsidered: 3,
          indexFilesLoaded: 3,
          indexMatchCount: 0,
          dirtyFiles: 0,
          realtimeFiles: 0,
          totalMatches: 0,
          totalMatchesExact: true,
          displayedMatches: 0,
          truncated: false,
          timings: { totalMs: 2 },
        },
      };
    });

    constructor(options: KernelDouble["options"]) {
      this.options = options;
      doubles.kernels.push(this as unknown as KernelDouble);
    }
  },
}));

vi.mock("../src/engine.js", () => ({
  FastGrepEngine: class {
    readonly options: Record<string, unknown>;
    readonly start = vi.fn(async () => undefined);
    readonly stop = vi.fn(async () => undefined);
    readonly search = vi.fn(async () => ({
      matches: [],
      metadata: {
        requestedBackend: "normal",
        actualBackend: "rg",
        dirtyFiles: 0,
        realtimeFiles: 0,
        totalMatches: 0,
        totalMatchesExact: true,
        displayedMatches: 0,
        truncated: false,
        timings: { totalMs: 4 },
      },
    }));
    readonly markToolPath = vi.fn();
    readonly markWorkspaceUnknown = vi.fn();
    readonly indexManager = { refreshInBackground: vi.fn() };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      doubles.fast.push(this);
    }
  },
}));

vi.mock("../src/fff-engine.js", () => ({
  FffEngine: class {
    readonly start = vi.fn(async () => undefined);
    readonly stop = vi.fn();
    readonly search = vi.fn();
    readonly markWorkspaceChanged = vi.fn();
  },
}));

import fastGrepExtension, {
  KERNEL_HOST_CONTRACT,
  parseKernelAddonPathFlag,
  parseKernelHostContractFlag,
  registerFastGrepExtension,
  resolvePackagedKernelAddonPath,
} from "../src/extension.js";

type Handler = (...args: never[]) => unknown;

function extensionHarness(
  initialBackend = "kernel-dev",
  addonPath: boolean | string | undefined = "/tmp/pi-fast-grep-kernel.node",
  hostContract: boolean | string | undefined = KERNEL_HOST_CONTRACT,
  register: (api: ExtensionAPI) => void = fastGrepExtension,
) {
  const flags = new Map<string, boolean | string | undefined>([
    ["fast-grep-backend", initialBackend],
    ["fast-grep-kernel-addon", addonPath],
    ["fast-grep-kernel-host-contract", hostContract],
  ]);
  const handlers = new Map<string, Handler>();
  const registeredFlags = new Map<string, Record<string, unknown>>();
  const tools: Array<Record<string, unknown>> = [];
  const toolIdentityOverrides = new Map<
    string,
    { parameters?: unknown; path?: string; source?: string }
  >();
  const api = {
    registerFlag: (name: string, options: Record<string, unknown>) => {
      registeredFlags.set(name, options);
    },
    registerTool: (tool: unknown) => tools.push(tool as Record<string, unknown>),
    getFlag: (name: string) => flags.get(name),
    getAllTools: () => {
      const builtins = ["read", "find", "ls"].map((name) => {
        const override = toolIdentityOverrides.get(name);
        return {
          name,
          description: `${name} builtin`,
          parameters: override?.parameters ?? {},
          sourceInfo: {
            path: override?.path ?? `<builtin:${name}>`,
            source: override?.source ?? "builtin",
            scope: "temporary",
            origin: "top-level",
          },
        };
      });
      const registered = tools.map((tool) => {
        const name = String(tool.name);
        const override = toolIdentityOverrides.get(name);
        return {
          name,
          description: String(tool.description ?? ""),
          parameters: override?.parameters ?? tool.parameters,
          promptGuidelines: tool.promptGuidelines,
          sourceInfo: {
            path: override?.path ?? "/tmp/pi-fast-grep-extension.ts",
            source: override?.source ?? "explicit",
            scope: "temporary",
            origin: "top-level",
          },
        };
      });
      return [...builtins, ...registered];
    },
    on: (event: string, eventHandler: Handler) => handlers.set(event, eventHandler),
  } as unknown as ExtensionAPI;
  register(api);
  return {
    flags,
    handlers,
    registeredFlags,
    toolIdentityOverrides,
    tools,
  };
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

function grepExecute(harness: ReturnType<typeof extensionHarness>) {
  const execute = harness.tools[0]?.execute;
  if (typeof execute !== "function") throw new Error("grep tool was not registered");
  return execute as (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

function startEvent(toolName: string): ToolExecutionStartEvent {
  return {
    type: "tool_execution_start",
    toolCallId: `call-${toolName}`,
    toolName,
    args: {},
  } satisfies ToolExecutionStartEvent;
}

describe("Pi kernel-dev adapter", () => {
  beforeEach(() => {
    doubles.feeds.length = 0;
    doubles.kernels.length = 0;
    doubles.fast.length = 0;
    doubles.failNextKernelStart = false;
    doubles.searchBarrier = undefined;
  });

  test("keeps auto as the default and registers addon as an explicit no-default flag", () => {
    const harness = extensionHarness("auto", undefined);

    expect(harness.registeredFlags.get("fast-grep-backend")).toMatchObject({
      default: "auto",
    });
    expect(harness.registeredFlags.get("fast-grep-kernel-addon")).toMatchObject({
      type: "string",
    });
    expect(harness.registeredFlags.get("fast-grep-kernel-addon")).not.toHaveProperty(
      "default",
    );
    expect(
      harness.registeredFlags.get("fast-grep-kernel-host-contract"),
    ).toMatchObject({ type: "string" });
    expect(
      harness.registeredFlags.get("fast-grep-kernel-host-contract"),
    ).not.toHaveProperty("default");
  });

  test("resolves the packaged addon from the package without absolute-path flags", async () => {
    const moduleDirectory = path.resolve("src");
    const addonPath = await resolvePackagedKernelAddonPath(moduleDirectory);
    const harness = extensionHarness(
      "kernel",
      undefined,
      undefined,
      (api) => registerFastGrepExtension(api, {
        defaultBackend: "kernel",
        moduleDirectory,
      }),
    );
    const ctx = fakeContext("/tmp/pi-fast-grep-packaged-kernel");

    await handler(harness.handlers, "session_start")({}, ctx);

    expect(harness.registeredFlags.get("fast-grep-backend")).toMatchObject({
      default: "kernel",
    });
    expect(doubles.kernels[0]?.options.addonPath).toBe(addonPath);
    expect(doubles.kernels[0]?.options.trustedMutationFeed).toBe(doubles.feeds[0]);
  });

  test("reports the exact packaged addon target when the platform build is absent", async () => {
    await expect(
      resolvePackagedKernelAddonPath(path.resolve("src"), "missing-os", "missing-arch"),
    ).rejects.toThrow(/missing-os-missing-arch.*pi-fast-grep-kernel\.missing-os-missing-arch\.node/u);
  });

  test.each([
    undefined,
    true,
    "",
    "relative.node",
    "/tmp/not-an-addon.js",
  ])("rejects an unsafe kernel addon path %#", (value) => {
    expect(() => parseKernelAddonPathFlag(value)).toThrow(
      /absolute .*\.node path/u,
    );
  });

  test.each([undefined, true, "", "some-other-contract"])(
    "rejects a missing or unknown kernel host contract %#",
    (value) => {
      expect(() => parseKernelHostContractFlag(value)).toThrow(
        new RegExp(KERNEL_HOST_CONTRACT, "u"),
      );
    },
  );

  test("requires the isolated host contract before constructing a kernel", async () => {
    const harness = extensionHarness(
      "kernel-dev",
      "/tmp/pi-fast-grep-kernel.node",
      "",
    );
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-missing-contract");

    await expect(
      handler(harness.handlers, "session_start")({}, ctx),
    ).rejects.toThrow(new RegExp(KERNEL_HOST_CONTRACT, "u"));
    expect(doubles.kernels).toHaveLength(0);
  });

  test("fails configuration before constructing a kernel for a relative addon", async () => {
    const harness = extensionHarness("kernel-dev", "relative.node");
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-invalid-addon");

    await expect(
      handler(harness.handlers, "session_start")({}, ctx),
    ).rejects.toThrow(/absolute \.node path/u);
    expect(doubles.feeds).toHaveLength(0);
    expect(doubles.kernels).toHaveLength(0);
  });

  test.each(["auto", "instant", "normal", "fff"])(
    "does not construct the opt-in kernel for %s",
    async (backend) => {
      const harness = extensionHarness(backend, undefined);
      const ctx = fakeContext(`/tmp/pi-fast-grep-non-kernel-${backend}`);

      await handler(harness.handlers, "session_start")({}, ctx);

      expect(doubles.feeds).toHaveLength(0);
      expect(doubles.kernels).toHaveLength(0);
    },
  );

  test("routes grep through one kernel instance and preserves honest metadata", async () => {
    const root = "/tmp/pi-fast-grep-kernel-extension";
    const addonPath = "/tmp/pi-fast-grep-kernel.node";
    const harness = extensionHarness("kernel-dev", addonPath);
    const ctx = fakeContext(root);

    await handler(harness.handlers, "session_start")({}, ctx);
    expect(doubles.kernels).toHaveLength(1);
    expect(doubles.kernels[0]?.options).toMatchObject({
      root,
      addonPath,
      trustedMutationFeed: doubles.feeds[0],
    });
    expect(doubles.kernels[0]?.start).toHaveBeenCalledOnce();

    const output = await grepExecute(harness)(
      "grep-call",
      { pattern: "needle", literal: true, context: 0, limit: 10 },
      undefined,
      undefined,
      ctx,
    );
    await grepExecute(harness)(
      "grep-call-2",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );

    expect(doubles.kernels).toHaveLength(1);
    expect(doubles.kernels[0]?.start).toHaveBeenCalledOnce();
    expect(doubles.kernels[0]?.search).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: "needle",
        literal: true,
        context: 0,
        limit: 10,
      }),
      undefined,
    );
    const metadata = output.details.metadata as {
      requestedBackend: string;
      actualBackend: string;
      kernelFreshnessMode: string;
      timings: { totalMs: number; formatMs?: number };
    };
    expect(metadata).toMatchObject({
      requestedBackend: "kernel-dev",
      actualBackend: "kernel",
      kernelFreshnessMode: "agent_loop_serialized_v1",
    });
    expect(metadata.timings.formatMs).toEqual(expect.any(Number));
    expect(metadata.timings.totalMs).toBeGreaterThanOrEqual(2);
  });

  test.each(["read", "grep", "find", "ls"])(
    "does not invalidate before known read-only %s",
    async (toolName) => {
      const harness = extensionHarness();
      const ctx = fakeContext("/tmp/pi-fast-grep-kernel-read-only");
      await handler(harness.handlers, "session_start")({}, ctx);

      const returned = handler(
        harness.handlers,
        "tool_execution_start",
      )(startEvent(toolName), ctx);

      await returned;
      expect(doubles.feeds[0]?.mark).not.toHaveBeenCalled();
      expect(doubles.feeds[0]?.reason).toBeUndefined();
    },
  );

  test.each(["write", "edit", "bash", "custom_mutator"])(
    "synchronously invalidates before potentially mutating %s",
    async (toolName) => {
      const harness = extensionHarness();
      const ctx = fakeContext(`/tmp/pi-fast-grep-kernel-${toolName}`);
      await handler(harness.handlers, "session_start")({}, ctx);

      const returned = handler(
        harness.handlers,
        "tool_execution_start",
      )(startEvent(toolName), ctx);

      expect(returned).toBeInstanceOf(Promise);
      await returned;
      expect(doubles.feeds[0]?.mark).toHaveBeenCalledOnce();
      expect(doubles.feeds[0]?.reason).toBe(
        `kernel_tool_execution_start:${toolName}`,
      );
      expect(doubles.kernels[0]?.markWorkspaceChanged).toHaveBeenCalledWith(
        `kernel_tool_execution_start:${toolName}`,
      );
    },
  );

  test("last preflight mutator closes the generation before any sibling body runs", async () => {
    const harness = extensionHarness();
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-parallel");
    await handler(harness.handlers, "session_start")({}, ctx);
    const toolStart = handler(harness.handlers, "tool_execution_start");

    for (const toolName of ["read", "find", "custom_mutator"]) {
      await toolStart(startEvent(toolName), ctx);
    }

    const siblingBodies = [1, 2, 3].map(async () => {
      expect(doubles.feeds[0]?.marked).toBe(true);
      expect(doubles.feeds[0]?.reason).toBe(
        "kernel_tool_execution_start:custom_mutator",
      );
    });
    await Promise.all(siblingBodies);
  });

  test.each([false, true])(
    "invalidates before direct user bash (excludeFromContext=%s)",
    async (excludeFromContext) => {
      const harness = extensionHarness();
      const root = "/tmp/pi-fast-grep-kernel-user-bash";
      const ctx = fakeContext(root);
      await handler(harness.handlers, "session_start")({}, ctx);
      const event = {
        type: "user_bash",
        command: "touch changed.txt",
        excludeFromContext,
        cwd: root,
      } satisfies UserBashEvent;

      const returned = handler(harness.handlers, "user_bash")(event, ctx);

      expect(returned).toBeUndefined();
      expect(doubles.feeds[0]?.reason).toBe("kernel_user_bash");
    },
  );

  test("rebuilds only after the last in-flight mutator result", async () => {
    const harness = extensionHarness();
    const root = "/tmp/pi-fast-grep-kernel-post-result";
    const ctx = fakeContext(root);
    await handler(harness.handlers, "session_start")({}, ctx);
    await handler(harness.handlers, "tool_execution_start")(
      startEvent("write"),
      ctx,
    );
    await handler(harness.handlers, "tool_execution_start")(
      startEvent("edit"),
      ctx,
    );
    const writeResult = {
      type: "tool_result",
      toolCallId: "call-write",
      toolName: "write",
      input: { path: "changed.txt", content: "changed" },
      content: [{ type: "text", text: "done" }],
      details: undefined,
      isError: false,
    } satisfies ToolResultEvent;
    const editResult = {
      ...writeResult,
      toolCallId: "call-edit",
      toolName: "edit",
      input: { path: "other.txt" },
    } satisfies ToolResultEvent;

    handler(harness.handlers, "tool_result")(writeResult, ctx);
    await Promise.resolve();
    expect(doubles.kernels).toHaveLength(1);

    handler(harness.handlers, "tool_result")(editResult, ctx);
    const output = await grepExecute(harness)(
      "grep-after-recovery",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );

    expect(doubles.kernels).toHaveLength(2);
    expect(doubles.kernels[1]?.options).toMatchObject({
      root,
      sessionWorktreeSnapshot: true,
    });
    expect(output.details.metadata).toMatchObject({
      actualBackend: "kernel",
      requestedBackend: "kernel-dev",
    });
  });

  test("does not dispatch a mutator until an in-flight grep completes", async () => {
    let releaseSearch!: () => void;
    doubles.searchBarrier = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const harness = extensionHarness();
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-linearization");
    await handler(harness.handlers, "session_start")({}, ctx);
    const searching = grepExecute(harness)(
      "grep-in-flight",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(doubles.kernels[0]?.search).toHaveBeenCalledOnce());

    let mutatorDispatched = false;
    const mutationReady = Promise.resolve(
      handler(harness.handlers, "tool_execution_start")(
        startEvent("edit"),
        ctx,
      ),
    ).then(() => {
      mutatorDispatched = true;
    });
    await Promise.resolve();
    expect(mutatorDispatched).toBe(false);
    expect(doubles.feeds[0]?.marked).toBe(false);

    releaseSearch();
    await searching;
    await mutationReady;
    expect(mutatorDispatched).toBe(true);
    expect(doubles.feeds[0]?.reason).toBe("kernel_tool_execution_start:edit");
  });

  test("retains a failed start as a permanent full-rg fallback without retry", async () => {
    doubles.failNextKernelStart = true;
    const harness = extensionHarness();
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-start-failure");
    await handler(harness.handlers, "session_start")({}, ctx);

    const first = await grepExecute(harness)(
      "grep-1",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );
    const second = await grepExecute(harness)(
      "grep-2",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );

    expect(doubles.kernels).toHaveLength(1);
    expect(doubles.kernels[0]?.start).toHaveBeenCalledOnce();
    expect(doubles.kernels[0]?.search).toHaveBeenCalledTimes(2);
    expect(
      (first.details.metadata as { actualBackend: string }).actualBackend,
    ).toBe("rg_fallback");
    expect(
      (second.details.metadata as { fallbackReason?: string }).fallbackReason,
    ).toBe("kernel_start_failed");
  });

  test.each(["read", "find", "ls", "grep"])(
    "fails closed when the read-only %s identity is not trusted",
    async (toolName) => {
      const harness = extensionHarness();
      harness.toolIdentityOverrides.set(
        toolName,
        toolName === "grep"
          ? { parameters: {} }
          : {
              path: `/tmp/overrides/${toolName}.ts`,
              source: "extension",
            },
      );
      const ctx = fakeContext(`/tmp/pi-fast-grep-kernel-identity-${toolName}`);
      await handler(harness.handlers, "session_start")({}, ctx);

      const output = await grepExecute(harness)(
        "grep-untrusted-host",
        { pattern: "needle", literal: true },
        undefined,
        undefined,
        ctx,
      );

      expect(
        (output.details.metadata as {
          actualBackend: string;
          fallbackReason?: string;
        }),
      ).toMatchObject({
        actualBackend: "rg_fallback",
        fallbackReason: `kernel_untrusted_tool_identity:${toolName}`,
      });
    },
  );

  test("carries a preflight mutation epoch into a later kernel construction", async () => {
    const harness = extensionHarness("normal");
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-late-enable");
    await handler(harness.handlers, "session_start")({}, ctx);
    await handler(harness.handlers, "tool_execution_start")(
      startEvent("write"),
      ctx,
    );

    harness.flags.set("fast-grep-backend", "kernel-dev");
    const output = await grepExecute(harness)(
      "grep-after-late-enable",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );

    expect(doubles.kernels).toHaveLength(1);
    expect(doubles.kernels[0]?.start).toHaveBeenCalledOnce();
    expect(
      (output.details.metadata as {
        actualBackend: string;
        fallbackReason?: string;
      }),
    ).toMatchObject({
      actualBackend: "rg_fallback",
      fallbackReason: "kernel_tool_execution_start:write",
    });
  });

  test("closes on addon/backend changes and on session shutdown", async () => {
    const harness = extensionHarness();
    const ctx = fakeContext("/tmp/pi-fast-grep-kernel-lifecycle");
    await handler(harness.handlers, "session_start")({}, ctx);
    const first = doubles.kernels[0]!;

    harness.flags.set(
      "fast-grep-kernel-addon",
      "/tmp/pi-fast-grep-kernel-v2.node",
    );
    await grepExecute(harness)(
      "grep-addon-switch",
      { pattern: "needle", literal: true },
      undefined,
      undefined,
      ctx,
    );
    expect(first.close).toHaveBeenCalledOnce();
    expect(doubles.kernels).toHaveLength(2);
    const second = doubles.kernels[1]!;

    harness.flags.set("fast-grep-backend", "normal");
    await grepExecute(harness)(
      "grep-backend-switch",
      { pattern: "needle" },
      undefined,
      undefined,
      ctx,
    );
    expect(second.close).toHaveBeenCalledOnce();
    expect(doubles.fast).toHaveLength(1);

    await handler(harness.handlers, "session_shutdown")();
    expect(doubles.fast[0]?.stop).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
