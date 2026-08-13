import { stat } from "node:fs/promises";
import path from "node:path";

import {
  createGrepToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { normalizeInitialDirtyPaths } from "./dirty-tracker.js";
import { FastGrepEngine } from "./engine.js";
import { formatSearchResult } from "./format.js";
import type { FffEngine } from "./fff-engine.js";
import type {
  KernelMutationFeed,
  OptInKernelEngine,
} from "./kernel-engine.js";
import type {
  SearchMetadata,
  SearchRequest,
  SearchResult,
} from "./types.js";

type BackendFlag = "auto" | "instant" | "normal" | "fff" | "kernel" | "kernel-dev";
type FastBackendFlag = Exclude<BackendFlag, "fff" | "kernel" | "kernel-dev">;

type ActiveEngine =
  | {
    kind: "fast";
    root: string;
    value: FastGrepEngine;
  }
  | {
    kind: "fff";
    root: string;
    value: FffEngine;
  }
  | {
    kind: "kernel";
    root: string;
    addonPath: string;
    value: OptInKernelEngine;
    mutationFeed: KernelMutationFeed;
  };

const KERNEL_READ_ONLY_TOOLS = new Set(["grep", "read", "find", "ls"]);
export const KERNEL_HOST_CONTRACT = "isolated-pi-v1" as const;

export const FAST_GREP_PROMPT_SNIPPET =
  "Search large codebases quickly with regex and path/glob filters, indexed candidates, and exact verification";

export const FAST_GREP_PROMPT_GUIDELINES = [
  "Use grep for code search instead of running rg in bash; grep uses the index when safe and falls back automatically.",
  "Use grep path or glob filters to narrow broad result sets, and increase limit only when the truncation notice requires it.",
  "If an indexed empty result conflicts with known repository evidence, or the metadata suggests an index/adapter issue, verify once with `rg --no-config` in bash before concluding absence. Do not repeat the check when grep already reports the rg or rg_fallback backend.",
] as const;

function backendFlag(value: boolean | string | undefined): BackendFlag {
  if (value === undefined || value === "auto") return "auto";
  if (
    value === "instant"
    || value === "normal"
    || value === "fff"
    || value === "kernel"
    || value === "kernel-dev"
  ) {
    return value;
  }
  throw new Error(
    `--fast-grep-backend must be auto, instant, normal, fff, kernel, or kernel-dev (received ${String(value)})`,
  );
}

export async function resolvePackagedKernelAddonPath(
  moduleDirectory = import.meta.dirname,
  platform: string = process.platform,
  architecture: string = process.arch,
): Promise<string> {
  const filename = `pi-fast-grep-kernel.${platform}-${architecture}.node`;
  const candidates = [
    path.resolve(moduleDirectory, "../native", filename),
    path.resolve(moduleDirectory, "../native/kernel/binding", filename),
    path.resolve(moduleDirectory, "../../native/kernel/binding", filename),
  ];
  for (const addonPath of candidates) {
    try {
      const addonStat = await stat(addonPath);
      if (addonStat.isFile()) return addonPath;
    } catch {
      // Try the source/npm package layout after the standalone artifact layout.
    }
  }
  throw new Error(
    `packaged kernel addon is missing for ${platform}-${architecture}; checked ${candidates.join(", ")}`,
  );
}

export function parseKernelAddonPathFlag(
  value: boolean | string | undefined,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "--fast-grep-kernel-addon must be an explicit absolute .node path when kernel-dev is selected",
    );
  }
  if (!path.isAbsolute(value) || path.extname(value) !== ".node") {
    throw new Error("--fast-grep-kernel-addon must be an absolute .node path");
  }
  return path.normalize(value);
}

export function parseKernelHostContractFlag(
  value: boolean | string | undefined,
): typeof KERNEL_HOST_CONTRACT {
  if (value !== KERNEL_HOST_CONTRACT) {
    throw new Error(
      `--fast-grep-kernel-host-contract must be ${KERNEL_HOST_CONTRACT} when kernel-dev is selected`,
    );
  }
  return value;
}

export function kernelToolMayMutate(toolName: string): boolean {
  return !KERNEL_READ_ONLY_TOOLS.has(toolName);
}

export class KernelSessionGate {
  private readers = 0;
  private readonly mutations = new Set<string>();
  private readonly readerWaiters = new Set<() => void>();
  private readonly drainWaiters = new Set<() => void>();

  get mutationActive(): boolean {
    return this.mutations.size > 0;
  }

  async enterRead(): Promise<() => void> {
    while (this.mutationActive) {
      await new Promise<void>((resolve) => this.readerWaiters.add(resolve));
    }
    this.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers -= 1;
      if (this.readers === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  async beginMutation(toolCallId: string): Promise<void> {
    if (this.mutations.has(toolCallId)) return;
    // Queue the writer before waiting so no later grep can overtake it.
    this.mutations.add(toolCallId);
    if (this.readers === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  finishMutation(toolCallId: string): boolean {
    if (!this.mutations.delete(toolCallId)) return false;
    if (!this.mutationActive) {
      for (const resolve of this.readerWaiters) resolve();
      this.readerWaiters.clear();
    }
    return true;
  }
}

function kernelHostToolIdentityFailure(
  pi: ExtensionAPI,
  expectedGrepParameters: unknown,
): string | undefined {
  let tools;
  try {
    tools = pi.getAllTools();
  } catch {
    return "kernel_host_tool_identity_unavailable";
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const grep = byName.get("grep");
  if (
    grep === undefined
    // Pi exposes the exact registered definition parameters object. Reference
    // equality proves that another extension did not win the grep override.
    || grep.parameters !== expectedGrepParameters
  ) {
    return "kernel_untrusted_tool_identity:grep";
  }
  for (const name of ["read", "find", "ls"] as const) {
    const tool = byName.get(name);
    if (tool === undefined) continue;
    if (
      tool.sourceInfo.source !== "builtin"
      || tool.sourceInfo.path !== `<builtin:${name}>`
    ) {
      return `kernel_untrusted_tool_identity:${name}`;
    }
  }
  return undefined;
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function stopEngine(active: ActiveEngine): Promise<void> {
  if (active.kind === "fff") {
    active.value.stop();
    return;
  }
  if (active.kind === "kernel") {
    active.value.close();
    return;
  }
  await active.value.stop();
}

export function parseInitialDirtyPathsFlag(
  value: boolean | string | undefined,
  root: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("--fast-grep-initial-dirty-paths must be a JSON string array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--fast-grep-initial-dirty-paths must be valid JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
    throw new Error("--fast-grep-initial-dirty-paths must be a JSON string array");
  }
  try {
    return normalizeInitialDirtyPaths(root, parsed);
  } catch (error) {
    throw new Error(
      `invalid --fast-grep-initial-dirty-paths: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface FastGrepExtensionOptions {
  defaultBackend: BackendFlag;
  moduleDirectory: string;
}

export function registerFastGrepExtension(
  pi: ExtensionAPI,
  options: FastGrepExtensionOptions,
): void {
  let engine: ActiveEngine | undefined;
  let registeredGrepParameters: unknown;
  let pendingKernelMutationReason: string | undefined;
  let kernelNeedsRecovery = false;
  let kernelEpoch = 0;
  const kernelGate = new KernelSessionGate();
  let kernelRecovery: {
    epoch: number;
    candidate: Extract<ActiveEngine, { kind: "kernel" }> | undefined;
    promise: Promise<void>;
  } | undefined;

  pi.registerFlag("fast-grep-backend", {
    description: "Search backend: auto, instant, normal, fff, packaged kernel, or explicit kernel-dev",
    type: "string",
    default: options.defaultBackend,
  });

  pi.registerFlag("fast-grep-kernel-addon", {
    description:
      "Absolute native .node path required by the non-default kernel-dev backend",
    type: "string",
  });

  pi.registerFlag("fast-grep-kernel-host-contract", {
    description:
      `Required kernel-dev capability acknowledgement: ${KERNEL_HOST_CONTRACT}`,
    type: "string",
  });

  pi.registerFlag("fast-grep-initial-dirty-paths", {
    description:
      "Trusted JSON array of initial dirty repository-relative paths; skips only the first git status scan",
    type: "string",
  });

  const createKernelActive = async (
    root: string,
    addonPath: string,
    sessionWorktreeSnapshot: boolean,
  ): Promise<Extract<ActiveEngine, { kind: "kernel" }>> => {
    const {
      KernelMutationFeed: KernelMutationFeedConstructor,
      OptInKernelEngine: OptInKernelEngineConstructor,
    } = await import("./kernel-engine.js");
    const mutationFeed = new KernelMutationFeedConstructor();
    const kernel = new OptInKernelEngineConstructor({
      root,
      addonPath,
      trustedMutationFeed: mutationFeed,
      ...(sessionWorktreeSnapshot ? { sessionWorktreeSnapshot: true } : {}),
    });
    return {
      kind: "kernel",
      root,
      addonPath,
      value: kernel,
      mutationFeed,
    };
  };

  const recoverKernel = async (ctx: ExtensionContext): Promise<void> => {
    if (!kernelNeedsRecovery || kernelGate.mutationActive) return;
    if (kernelRecovery !== undefined) return kernelRecovery.promise;
    const previous = engine;
    if (previous?.kind !== "kernel" || previous.root !== ctx.cwd) return;
    const epoch = kernelEpoch;
    const recovery = {
      epoch,
      candidate: undefined as Extract<ActiveEngine, { kind: "kernel" }> | undefined,
      promise: Promise.resolve(),
    };
    recovery.promise = (async () => {
      const releaseRead = await kernelGate.enterRead();
      let candidate: Extract<ActiveEngine, { kind: "kernel" }> | undefined;
      try {
        candidate = await createKernelActive(
          previous.root,
          previous.addonPath,
          true,
        );
        recovery.candidate = candidate;
        await candidate.value.start();
        if (
          engine === previous
          && kernelNeedsRecovery
          && kernelEpoch === epoch
          && !kernelGate.mutationActive
          && !candidate.mutationFeed.marked
        ) {
          engine = candidate;
          kernelNeedsRecovery = false;
          previous.value.close();
        } else {
          candidate.value.close();
        }
      } catch (error) {
        candidate?.value.close();
        console.error(
          `[pi-fast-grep] kernel recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        releaseRead();
      }
    })().finally(() => {
      if (kernelRecovery === recovery) kernelRecovery = undefined;
    });
    kernelRecovery = recovery;
    return recovery.promise;
  };

  const ensureEngine = async (
    ctx: ExtensionContext,
    backend: BackendFlag,
  ): Promise<ActiveEngine> => {
    const kind: ActiveEngine["kind"] =
      backend === "fff"
        ? "fff"
        : backend === "kernel" || backend === "kernel-dev"
          ? "kernel"
          : "fast";
    const kernelAddonPath =
      backend === "kernel-dev"
        ? parseKernelAddonPathFlag(pi.getFlag("fast-grep-kernel-addon"))
        : backend === "kernel"
          ? await resolvePackagedKernelAddonPath(options.moduleDirectory)
          : undefined;
    if (backend === "kernel-dev") {
      parseKernelHostContractFlag(
        pi.getFlag("fast-grep-kernel-host-contract"),
      );
    }
    if (engine?.root === ctx.cwd && engine.kind === kind) {
      if (
        engine.kind !== "kernel"
        || engine.addonPath === kernelAddonPath
      ) {
        return engine;
      }
    }
    const previous = engine;
    kernelEpoch += 1;
    kernelNeedsRecovery = false;
    kernelRecovery?.candidate?.mutationFeed.mark("kernel_engine_replaced");
    engine = undefined;
    if (previous) await stopEngine(previous);

    if (backend === "fff") {
      const { FffEngine: FffEngineConstructor } = await import("./fff-engine.js");
      const fff = new FffEngineConstructor(ctx.cwd);
      await fff.start();
      engine = { kind: "fff", root: ctx.cwd, value: fff };
      return engine;
    }

    if (backend === "kernel" || backend === "kernel-dev") {
      if (kernelAddonPath === undefined) {
        throw new Error(`${backend} addon path was not resolved`);
      }
      const active = await createKernelActive(ctx.cwd, kernelAddonPath, false);
      const initialInvalidReason = kernelHostToolIdentityFailure(
        pi,
        registeredGrepParameters,
      ) ?? pendingKernelMutationReason;
      if (initialInvalidReason !== undefined) {
        active.mutationFeed.mark(initialInvalidReason);
      }
      engine = active;
      try {
        await active.value.start();
      } catch (error) {
        // A valid kernel-dev configuration remains fail-closed: the engine
        // latches kernel_start_failed and serves full-rg fallback thereafter.
        console.error(
          `[pi-fast-grep] kernel startup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        active.value.markWorkspaceChanged(
          active.mutationFeed.reason ?? "kernel_start_failed",
        );
      }
      return active;
    }

    const initialDirtyPaths = parseInitialDirtyPathsFlag(
      pi.getFlag("fast-grep-initial-dirty-paths"),
      ctx.cwd,
    );
    const fast = new FastGrepEngine({
      root: ctx.cwd,
      requestedBackend: backend,
      ...(initialDirtyPaths === undefined ? {} : { initialDirtyPaths }),
    });
    try {
      await fast.start({ waitForIndex: false });
    } catch (error) {
      await fast.stop();
      throw error;
    }
    engine = { kind: "fast", root: ctx.cwd, value: fast };
    return engine;
  };

  const fallbackDefinition = createGrepToolDefinition(process.cwd());
  const fallbackDefinitions = new Map([
    [path.resolve(process.cwd()), fallbackDefinition],
  ]);
  const fallbackDefinitionFor = (root: string) => {
    const resolvedRoot = path.resolve(root);
    const cached = fallbackDefinitions.get(resolvedRoot);
    if (cached !== undefined) return cached;
    const created = createGrepToolDefinition(resolvedRoot);
    fallbackDefinitions.set(resolvedRoot, created);
    return created;
  };
  const grep = defineTool({
    ...fallbackDefinition,
    label: "Fast code search",
    description:
      "Search code quickly in large repositories with regex and path/glob filters, " +
      "using the selected index as a recall-safe candidate source and exact ripgrep verification. " +
      "Returns line numbers and two context lines by default, respects .gitignore, " +
      "reports truncation explicitly, and automatically falls back to ripgrep.",
    promptSnippet: FAST_GREP_PROMPT_SNIPPET,
    promptGuidelines: [...FAST_GREP_PROMPT_GUIDELINES],
    executionMode: "sequential" as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const backend = backendFlag(pi.getFlag("fast-grep-backend"));
      const releaseRead = backend === "kernel" || backend === "kernel-dev"
        ? await kernelGate.enterRead()
        : undefined;
      try {
        let activeEngine = await ensureEngine(ctx, backend);
        if (activeEngine.kind === "kernel" && kernelNeedsRecovery) {
          await recoverKernel(ctx);
          if (engine?.kind === "kernel") activeEngine = engine;
        }
        const request: SearchRequest = {
          pattern: params.pattern,
          ...(params.path === undefined ? {} : { path: params.path }),
          ...(params.glob === undefined ? {} : { glob: params.glob }),
          ...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
          ...(params.literal === undefined ? {} : { literal: params.literal }),
          context: params.context ?? 2,
          limit: Math.max(1, Math.floor(params.limit ?? 100)),
          hidden: true,
        };
        try {
          onUpdate?.({
            content: [{ type: "text", text: backend === "normal" ? "Searching with ripgrep..." : "Searching index..." }],
            details: undefined,
          });
          let result: SearchResult;
          if (activeEngine.kind === "fff") {
            if (backend !== "fff") throw new Error("FFF engine selected for a non-FFF request");
            result = await activeEngine.value.search(request, {
              ...(signal === undefined ? {} : { signal }),
            });
          } else if (activeEngine.kind === "kernel") {
            if (backend !== "kernel" && backend !== "kernel-dev") {
              throw new Error("kernel engine selected for a non-kernel request");
            }
            result = await activeEngine.value.search(request, signal);
            result.metadata.requestedBackend = backend;
          } else {
            if (backend === "fff" || backend === "kernel" || backend === "kernel-dev") {
              throw new Error("FastGrepEngine selected for an incompatible request");
            }
            const fastBackend: FastBackendFlag = backend;
            result = await activeEngine.value.search(request, {
              backend: fastBackend,
              ...(signal === undefined ? {} : { signal }),
            });
          }
          const formatStartedAt = performance.now();
          const formatted = formatSearchResult(result, request);
          const formatMs = performance.now() - formatStartedAt;
          result.metadata.timings.formatMs = formatMs;
          result.metadata.timings.totalMs += formatMs;
          return {
            content: [{ type: "text", text: formatted.text }],
            details: formatted.details,
          };
        } catch (error) {
          if (abortError(error) || signal?.aborted) throw error;
          // The built-in implementation is the final safety net for adapter bugs.
          const fallback = await fallbackDefinitionFor(ctx.cwd).execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
          const details = (fallback.details ?? {}) as Record<string, unknown>;
          const metadata: SearchMetadata = {
            requestedBackend: backend,
            actualBackend: "rg_fallback",
            fallbackReason: `fast_grep adapter error: ${error instanceof Error ? error.message : String(error)}`,
            dirtyFiles: 0,
            realtimeFiles: 0,
            totalMatches: 0,
            totalMatchesExact: false,
            displayedMatches: 0,
            truncated: false,
            timings: { totalMs: 0 },
          };
          return {
            ...fallback,
            details: { ...details, linesTruncated: Boolean(details.linesTruncated), metadata },
          };
        }
      } finally {
        releaseRead?.();
      }
    },
  });
  registeredGrepParameters = grep.parameters;

  pi.registerTool(grep);

  pi.on("session_start", async (_event, ctx) => {
    kernelEpoch += 1;
    kernelNeedsRecovery = false;
    pendingKernelMutationReason = undefined;
    await ensureEngine(ctx, backendFlag(pi.getFlag("fast-grep-backend")));
  });

  const noteKernelMutation = (reason: string): void => {
    if (engine?.kind !== "kernel") return;
    kernelEpoch += 1;
    kernelNeedsRecovery = true;
    engine.mutationFeed.mark(reason);
    kernelRecovery?.candidate?.mutationFeed.mark(reason);
  };

  pi.on("tool_execution_start", (event) => {
    if (!kernelToolMayMutate(event.toolName)) return;
    const reason = `kernel_tool_execution_start:${event.toolName}`;
    if (engine?.kind !== "kernel") {
      pendingKernelMutationReason ??= reason;
      return;
    }
    // Queue the writer, drain every earlier grep/rebuild, then invalidate the
    // current generation immediately before Pi dispatches the mutator body.
    return kernelGate.beginMutation(event.toolCallId).then(() => {
      noteKernelMutation(reason);
    });
  });

  pi.on("user_bash", () => {
    // Direct user bash runs while the agent loop is idle and has no paired
    // completion event. Invalidate before dispatch; the next grep rebuilds
    // lazily after the synchronous user command has returned.
    noteKernelMutation("kernel_user_bash");
  });

  pi.on("tool_result", (event, ctx) => {
    const completedKernelMutation = kernelGate.finishMutation(event.toolCallId);
    if (engine?.kind === "kernel") {
      if (completedKernelMutation && !kernelGate.mutationActive) {
        void recoverKernel(ctx);
      }
      return;
    }
    if (!engine) return;
    if (event.toolName === "write" || event.toolName === "edit") {
      if (engine.kind === "fff") engine.value.markWorkspaceChanged();
      else engine.value.markToolPath(event.input.path, ctx.cwd);
      return;
    }
    if (event.toolName === "bash") {
      if (engine.kind === "fff") {
        engine.value.markWorkspaceChanged();
      } else {
        engine.value.markWorkspaceUnknown();
        engine.value.indexManager.refreshInBackground();
      }
    }
  });

  pi.on("session_shutdown", async () => {
    kernelEpoch += 1;
    kernelNeedsRecovery = false;
    kernelRecovery?.candidate?.mutationFeed.mark("kernel_session_shutdown");
    await kernelRecovery?.promise;
    const active = engine;
    engine = undefined;
    kernelRecovery = undefined;
    pendingKernelMutationReason = undefined;
    if (active) await stopEngine(active);
  });
}

export default function fastGrepExtension(pi: ExtensionAPI): void {
  registerFastGrepExtension(pi, {
    defaultBackend: "auto",
    moduleDirectory: import.meta.dirname,
  });
}

export function packagedFastGrepExtension(pi: ExtensionAPI): void {
  registerFastGrepExtension(pi, {
    defaultBackend: "kernel",
    moduleDirectory: import.meta.dirname,
  });
}
