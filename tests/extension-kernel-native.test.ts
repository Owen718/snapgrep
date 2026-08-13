import { readdir, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolExecutionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import fastGrepExtension, {
  KERNEL_HOST_CONTRACT,
} from "../src/extension.ts";
import { runCommand } from "../src/process.ts";
import { runRipgrep } from "../src/rg.ts";

const nativeEnabled = process.env.PI_FAST_GREP_NATIVE_TEST === "1";
type Handler = (...args: never[]) => unknown;

function handler(
  handlers: ReadonlyMap<string, Handler>,
  name: string,
): (...args: unknown[]) => unknown {
  const registered = handlers.get(name);
  if (registered === undefined) throw new Error(`missing ${name} handler`);
  return registered as (...args: unknown[]) => unknown;
}

describe.skipIf(!nativeEnabled)("Pi kernel-dev native adapter", () => {
  let fixture: string;
  let addonPath: string;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-kernel-extension-"));
    await mkdir(path.join(fixture, "src"), { recursive: true });
    await writeFile(path.join(fixture, ".gitignore"), ".pi/index/\n");
    await writeFile(path.join(fixture, "A.txt"), "before\nneedle original\nafter\n");
    await writeFile(path.join(fixture, "src", "other.txt"), "nothing here\n");
    await runCommand("git", ["init", "-q"], { cwd: fixture });
    await runCommand("git", ["config", "user.email", "kernel@example.invalid"], {
      cwd: fixture,
    });
    await runCommand("git", ["config", "user.name", "Kernel Test"], {
      cwd: fixture,
    });
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "fixture"], { cwd: fixture });

    const bindingDirectory = path.resolve(
      import.meta.dirname,
      "..",
      "native",
      "kernel",
      "binding",
    );
    const addons = (await readdir(bindingDirectory)).filter((entry) =>
      entry.endsWith(".node")
    );
    expect(addons).toHaveLength(1);
    addonPath = path.join(bindingDirectory, addons[0] as string);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    await rm(fixture, { recursive: true, force: true });
  });

  it("recovers kernel results after two edits and a bash mutation", async () => {
    const flags = new Map<string, boolean | string | undefined>([
      ["fast-grep-backend", "kernel-dev"],
      ["fast-grep-kernel-addon", addonPath],
      ["fast-grep-kernel-host-contract", KERNEL_HOST_CONTRACT],
    ]);
    const handlers = new Map<string, Handler>();
    const tools: Array<Record<string, unknown>> = [];
    fastGrepExtension({
      registerFlag: () => undefined,
      registerTool: (tool: unknown) => tools.push(tool as Record<string, unknown>),
      getFlag: (name: string) => flags.get(name),
      getAllTools: () => [
        ...["read", "find", "ls"].map((name) => ({
          name,
          description: `${name} builtin`,
          parameters: {},
          sourceInfo: {
            path: `<builtin:${name}>`,
            source: "builtin",
            scope: "temporary",
            origin: "top-level",
          },
        })),
        ...tools.map((tool) => ({
          name: String(tool.name),
          description: String(tool.description ?? ""),
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines,
          sourceInfo: {
            path: "/tmp/pi-fast-grep-extension.ts",
            source: "explicit",
            scope: "temporary",
            origin: "top-level",
          },
        })),
      ],
      on: (event: string, eventHandler: Handler) => {
        handlers.set(event, eventHandler);
      },
    } as unknown as ExtensionAPI);
    const ctx = { cwd: fixture } as ExtensionContext;
    await handler(handlers, "session_start")({}, ctx);
    shutdown = async () => {
      await handler(handlers, "session_shutdown")();
    };

    const execute = tools[0]?.execute;
    if (typeof execute !== "function") throw new Error("grep tool was not registered");
    const request = {
      pattern: "needle",
      literal: true,
      context: 0,
      limit: 100,
    };
    const first = await execute(
      "grep-before",
      request,
      undefined,
      undefined,
      ctx,
    ) as {
      details: {
        matches: unknown[];
        metadata: {
          requestedBackend: string;
          actualBackend: string;
          kernelFreshnessMode: string;
        };
      };
    };
    const beforeNormal = await runRipgrep(
      fixture,
      { ...request, hidden: true },
    );
    expect(first.details.matches).toEqual(beforeNormal.matches);
    expect(first.details.metadata).toMatchObject({
      requestedBackend: "kernel-dev",
      actualBackend: "kernel",
      kernelFreshnessMode: "agent_loop_serialized_v1",
    });

    const mutateAndSearch = async (
      toolCallId: string,
      toolName: "edit" | "bash",
      input: Record<string, unknown>,
      mutate: () => Promise<void>,
    ) => {
      await handler(handlers, "tool_execution_start")({
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args: input,
      } satisfies ToolExecutionStartEvent, ctx);
      await mutate();
      handler(handlers, "tool_result")({
        type: "tool_result",
        toolCallId,
        toolName,
        input,
        content: [{ type: "text", text: "done" }],
        details: undefined,
        isError: false,
      } as ToolResultEvent, ctx);
      return await execute(
        `grep-after-${toolCallId}`,
        request,
        undefined,
        undefined,
        ctx,
      ) as {
        details: {
          matches: Array<{ path: string }>;
          metadata: {
            requestedBackend: string;
            actualBackend: string;
            fallbackReason?: string;
          };
        };
      };
    };

    const afterFirstEdit = await mutateAndSearch(
      "edit-first",
      "edit",
      { path: "A.txt" },
      () => writeFile(
        path.join(fixture, "A.txt"),
        "before\nneedle original\nneedle first edit\nafter\n",
      ),
    );
    const firstNormal = await runRipgrep(fixture, { ...request, hidden: true });
    expect(afterFirstEdit.details.matches).toEqual(firstNormal.matches);
    expect(afterFirstEdit.details.metadata).toMatchObject({
      requestedBackend: "kernel-dev",
      actualBackend: "kernel",
    });

    const afterSecondEdit = await mutateAndSearch(
      "edit-second",
      "edit",
      { path: "src/other.txt" },
      () => writeFile(path.join(fixture, "src", "other.txt"), "needle second edit\n"),
    );
    const secondNormal = await runRipgrep(fixture, { ...request, hidden: true });
    expect(afterSecondEdit.details.matches).toEqual(secondNormal.matches);
    expect(afterSecondEdit.details.metadata).toMatchObject({
      requestedBackend: "kernel-dev",
      actualBackend: "kernel",
    });

    const afterBash = await mutateAndSearch(
      "bash-third",
      "bash",
      { command: "create src/bash.txt" },
      () => writeFile(path.join(fixture, "src", "bash.txt"), "needle bash mutation\n"),
    );
    const afterNormal = await runRipgrep(fixture, { ...request, hidden: true });
    expect(afterBash.details.matches).toEqual(afterNormal.matches);
    expect(afterBash.details.matches.map((match) => match.path)).toContain(
      "src/bash.txt",
    );
    expect(afterBash.details.metadata).toMatchObject({
      requestedBackend: "kernel-dev",
      actualBackend: "kernel",
    });
  });
});
