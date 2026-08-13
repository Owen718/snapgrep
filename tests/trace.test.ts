import { describe, expect, it } from "vitest";

import {
  TRACE_SCHEMA_VERSION,
  TraceRecorder,
  computeThinkingSpans,
  hashPrompt,
  toolInputSignature,
  validateTrace,
  type TraceRun,
  type TraceRunMetadata,
} from "../src/trace.ts";

function metadata(): TraceRunMetadata {
  return {
    runId: "run-1",
    workflowId: "investigate-linux",
    comparisonId: "comparison-1",
    attempt: 1,
    repo: "R1-linux",
    repoSha: "0123456789abcdef",
    backendRequested: "instant",
    model: "example/model-id",
    thinking: "medium",
    promptHash: hashPrompt("find the implementation"),
  };
}

function recorder(): TraceRecorder {
  return new TraceRecorder(metadata(), { wallNow: () => new Date("2026-07-23T00:00:00.000Z") });
}

describe("TraceRecorder", () => {
  it("pairs lifecycle events by toolCallId and records fast_grep result metadata", () => {
    const trace = recorder();
    trace.begin(100);
    trace.startTool("call-read", "read", 105, { path: "src/read.ts", offset: 1 }, "/repo");
    trace.endTool("call-read", { details: {} }, false, 108, "read");
    trace.startTool("call-grep", "grep", 110, { pattern: "secret-looking-pattern", path: "src", glob: "*.ts" }, "/repo");
    trace.endTool(
      "call-grep",
      {
        details: {
          metadata: {
            actualSearchBackend: "zoekt",
            fallbackReason: "dirty-file-verification",
            resultCount: 17,
            truncated: true,
          },
        },
      },
      false,
      112,
      "grep",
    );

    const run = trace.finish("completed", 115);
    const grep = run.events.find((event) => event.op === "grep");
    expect(grep).toMatchObject({
      tool: "grep",
      toolCallId: "call-grep",
      startMs: 10,
      endMs: 12,
      durationMs: 2,
      status: "ok",
      actualSearchBackend: "zoekt",
      fallbackReason: "dirty-file-verification",
      resultCount: 17,
      truncated: true,
      inputSignature: expect.objectContaining({
        schemaVersion: 1,
        argumentKeys: ["glob", "path", "pattern"],
      }),
    });
    expect(JSON.stringify(grep)).not.toContain("secret-looking-pattern");
    expect(run).toMatchObject({ schemaVersion: TRACE_SCHEMA_VERSION, totalMs: 15, status: "completed" });
    expect(() => validateTrace(run)).not.toThrow();
  });

  it("normalizes per-run checkout paths and keeps edit payloads redacted", () => {
    const first = toolInputSignature(
      "edit",
      { path: "/tmp/run-a/repo/src/file.ts", edits: [{ oldText: "private old", newText: "private new" }] },
      "/tmp/run-a/repo",
    );
    const second = toolInputSignature(
      "edit",
      { path: "/tmp/run-b/repo/src/file.ts", edits: [{ oldText: "private old", newText: "private new" }] },
      "/tmp/run-b/repo",
    );
    expect(first).toEqual(second);
    expect(first.pathHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toMatch(/private|file\.ts/);
  });

  it("records write as its own operation and aggregates assistant token usage", () => {
    const trace = recorder();
    trace.begin(10);
    trace.startTool("write-call", "write", 11, { path: "new.ts", content: "sensitive body" }, "/repo");
    trace.endTool("write-call", {}, false, 12, "write");
    trace.addTokenUsage({
      role: "assistant",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 1,
        totalTokens: 19,
        cost: { total: 0.01 },
      },
    });
    trace.addTokenUsage({ usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } });
    const run = trace.finish("completed", 14);
    expect(run.events.find((event) => event.op === "write")).toMatchObject({
      tool: "write",
      inputSignature: expect.objectContaining({ argumentKeys: ["content", "path"] }),
    });
    expect(JSON.stringify(run)).not.toContain("sensitive body");
    expect(run.tokenUsage).toEqual({
      input: 15,
      output: 6,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 1,
      totalTokens: 26,
      costTotal: 0.01,
    });
    expect(() => validateTrace(run)).not.toThrow();
  });

  it("preserves overlapping tool spans and derives thinking from their interval union", () => {
    const trace = recorder();
    trace.begin(100);
    trace.startTool("outer", "read", 102);
    trace.startTool("inner", "fast_grep", 104);
    trace.endTool("inner", { details: {} }, false, 107);
    trace.endTool("outer", { details: {} }, false, 110);

    const run = trace.finish("completed", 112);
    const tools = run.events.filter((event) => event.op !== "thinking");
    const thinking = run.events.filter((event) => event.op === "thinking");
    expect(tools).toEqual([
      expect.objectContaining({ toolCallId: "outer", startMs: 2, endMs: 10 }),
      expect.objectContaining({ toolCallId: "inner", startMs: 4, endMs: 7 }),
    ]);
    expect(thinking).toEqual([
      expect.objectContaining({ startMs: 0, endMs: 2, durationMs: 2 }),
      expect.objectContaining({ startMs: 10, endMs: 12, durationMs: 2 }),
    ]);
    expect(thinking.reduce((sum, event) => sum + event.durationMs, 0)).toBe(4);
  });

  it("covers the complete run continuously, including runs with no tools", () => {
    expect(computeThinkingSpans([], 9)).toEqual([
      { op: "thinking", startMs: 0, endMs: 9, durationMs: 9, status: "ok" },
    ]);

    const trace = recorder();
    trace.begin(10);
    const run = trace.finish("completed", 19);
    expect(run.events).toEqual([{ op: "thinking", startMs: 0, endMs: 9, durationMs: 9, status: "ok" }]);
    expect(() => validateTrace(run)).not.toThrow();
  });

  it("rejects unpaired lifecycle events and invalid monotonic times", () => {
    const unpaired = recorder();
    unpaired.begin(10);
    expect(() => unpaired.endTool("missing", {}, false, 11)).toThrow(/without matching start/);

    const duplicate = recorder();
    duplicate.begin(10);
    duplicate.startTool("same", "read", 11);
    expect(() => duplicate.startTool("same", "read", 12)).toThrow(/duplicate/);

    const backwards = recorder();
    backwards.begin(10);
    backwards.startTool("call", "read", 12);
    expect(() => backwards.endTool("call", {}, false, 11)).toThrow(/backwards/);
  });

  it("rejects traces with gaps or invalid durations", () => {
    const base: TraceRun = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      ...metadata(),
      startedAt: "2026-07-23T00:00:00.000Z",
      totalMs: 10,
      status: "completed",
      events: [{ op: "thinking", startMs: 0, endMs: 9, durationMs: 9, status: "ok" }],
    };
    expect(() => validateTrace(base)).toThrow(/complement/);

    const invalidDuration = structuredClone(base);
    invalidDuration.events[0] = { op: "thinking", startMs: 0, endMs: 10, durationMs: 9, status: "ok" };
    expect(() => validateTrace(invalidDuration)).toThrow(/duration/);
  });

  it("closes in-flight tools as aborted when the session shuts down", () => {
    const trace = recorder();
    trace.begin(10);
    trace.startTool("pending", "bash", 12);
    const run = trace.finish("aborted", 15);
    expect(run).toMatchObject({ status: "aborted", totalMs: 5 });
    expect(run.events.find((event) => event.op === "bash")).toMatchObject({
      toolCallId: "pending",
      startMs: 2,
      endMs: 5,
      status: "aborted",
    });
    expect(() => validateTrace(run)).not.toThrow();
  });
});
