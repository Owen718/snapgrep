import { randomUUID, createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
export const TRACE_SCHEMA_VERSION = 1;
const TIME_EPSILON_MS = 1e-6;
const RUN_STATUSES = new Set(["completed", "aborted"]);
const EVENT_STATUSES = new Set(["ok", "error", "aborted"]);
const OPERATIONS = new Set([
    "thinking",
    "grep",
    "read",
    "edit",
    "write",
    "bash",
    "find",
    "ls",
    "tool",
]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertFiniteTime(value, label) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite, non-negative number`);
    }
}
function sameTime(left, right) {
    return Math.abs(left - right) <= TIME_EPSILON_MS * Math.max(1, Math.abs(left), Math.abs(right));
}
function nonEmptyString(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`${key} must be a non-empty string`);
    return value;
}
function optionalString(record, key) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`${key} must be a non-empty string`);
    return value;
}
function optionalNumber(record, key) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${key} must be a finite, non-negative number`);
    }
    return value;
}
function normalizeToolOperation(tool) {
    switch (tool) {
        case "grep":
        case "fast_grep":
            return "grep";
        case "read":
            return "read";
        case "edit":
            return "edit";
        case "write":
            return "write";
        case "bash":
            return "bash";
        case "find":
            return "find";
        case "ls":
            return "ls";
        default:
            return "tool";
    }
}
function readFastGrepMetadata(tool, result) {
    // The production extension deliberately replaces Pi's built-in `grep`
    // definition, so current lifecycle events use `grep`; keep `fast_grep` for
    // traces produced by older/custom registrations.
    if ((tool !== "grep" && tool !== "fast_grep") || !isRecord(result))
        return {};
    const details = isRecord(result.details) ? result.details : undefined;
    const metadata = details && isRecord(details.metadata) ? details.metadata : undefined;
    if (!metadata)
        return {};
    const actualValue = metadata.actualSearchBackend ?? metadata.actualBackend;
    const fallbackValue = metadata.fallbackReason;
    const countValue = metadata.resultCount ?? metadata.displayedMatches ?? metadata.totalMatches ??
        (details && Array.isArray(details.matches) ? details.matches.length : undefined);
    const truncatedValue = metadata.truncated;
    const extracted = {};
    if (typeof actualValue === "string" && actualValue.length > 0)
        extracted.actualSearchBackend = actualValue;
    if (typeof fallbackValue === "string" && fallbackValue.length > 0)
        extracted.fallbackReason = fallbackValue;
    if (typeof countValue === "number" && Number.isFinite(countValue) && countValue >= 0) {
        extracted.resultCount = countValue;
    }
    if (typeof truncatedValue === "boolean")
        extracted.truncated = truncatedValue;
    return extracted;
}
/** SHA-256 of the exact expanded user prompt observed by before_agent_start. */
export function hashPrompt(prompt) {
    return createHash("sha256").update(prompt, "utf8").digest("hex");
}
function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
function pathForSignature(value, cwd) {
    if (!cwd)
        return path.normalize(value);
    const absolute = path.resolve(cwd, value);
    const relative = path.relative(path.resolve(cwd), absolute);
    if (relative === "")
        return "<repo>";
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return `<repo>/${relative.split(path.sep).join("/")}`;
    }
    // Keep external locations comparable without persisting the location itself.
    return `<external:${sha256(path.normalize(absolute))}>`;
}
function canonicalInput(value, cwd, key) {
    if (value === undefined)
        return { $undefined: true };
    if (value === null || typeof value === "boolean" || typeof value === "number")
        return value;
    if (typeof value === "string") {
        return key === "path" || key === "file_path" ? pathForSignature(value, cwd) : value;
    }
    if (Array.isArray(value))
        return value.map((item) => canonicalInput(item, cwd));
    if (!isRecord(value))
        return { $type: typeof value };
    const normalized = {};
    for (const childKey of Object.keys(value).sort()) {
        normalized[childKey] = canonicalInput(value[childKey], cwd, childKey);
    }
    return normalized;
}
function stableInput(value, cwd) {
    return JSON.stringify(canonicalInput(value, cwd));
}
/**
 * Build trajectory evidence without storing source paths, search text, or edit
 * payloads. Paths inside per-run clones normalize to the same repository token.
 */
export function toolInputSignature(tool, input, cwd) {
    const record = isRecord(input) ? input : {};
    const signature = {
        schemaVersion: 1,
        argumentKeys: Object.keys(record).sort(),
        digest: sha256(`${tool}\0${stableInput(input, cwd)}`),
    };
    if (typeof record.pattern === "string")
        signature.patternHash = sha256(record.pattern);
    const pathValue = typeof record.path === "string"
        ? record.path
        : typeof record.file_path === "string" ? record.file_path : undefined;
    if (pathValue !== undefined)
        signature.pathHash = sha256(pathForSignature(pathValue, cwd));
    if (typeof record.glob === "string")
        signature.globHash = sha256(record.glob);
    if (record.content !== undefined || record.edits !== undefined) {
        signature.payloadHash = sha256(stableInput({ content: record.content, edits: record.edits }));
    }
    return signature;
}
function tokenNumber(record, key) {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function extractTokenUsage(value) {
    if (!isRecord(value))
        return undefined;
    const usage = isRecord(value.usage) ? value.usage : value;
    const hasUsage = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]
        .some((key) => typeof usage[key] === "number");
    if (!hasUsage)
        return undefined;
    const input = tokenNumber(usage, "input");
    const output = tokenNumber(usage, "output");
    const cacheRead = tokenNumber(usage, "cacheRead");
    const cacheWrite = tokenNumber(usage, "cacheWrite");
    const reasoning = tokenNumber(usage, "reasoning");
    const reportedTotal = tokenNumber(usage, "totalTokens");
    const cost = isRecord(usage.cost) ? tokenNumber(usage.cost, "total") : 0;
    const extracted = {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: reportedTotal || input + output + cacheRead + cacheWrite,
    };
    if (typeof usage.reasoning === "number")
        extracted.reasoning = reasoning;
    if (isRecord(usage.cost) && typeof usage.cost.total === "number")
        extracted.costTotal = cost;
    return extracted;
}
/**
 * Return the complement of the union of tool intervals. Overlapping tool calls
 * remain separate in the trace, but never inflate or split thinking time.
 */
export function computeThinkingSpans(tools, totalMs) {
    assertFiniteTime(totalMs, "totalMs");
    const intervals = tools
        .map(({ startMs, endMs }) => {
        assertFiniteTime(startMs, "tool startMs");
        assertFiniteTime(endMs, "tool endMs");
        if (endMs < startMs)
            throw new Error("tool endMs must not precede startMs");
        if (endMs > totalMs && !sameTime(endMs, totalMs))
            throw new Error("tool endMs exceeds totalMs");
        return { startMs, endMs: Math.min(endMs, totalMs) };
    })
        .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    const merged = [];
    for (const interval of intervals) {
        const previous = merged.at(-1);
        if (!previous || interval.startMs > previous.endMs) {
            merged.push({ ...interval });
        }
        else {
            previous.endMs = Math.max(previous.endMs, interval.endMs);
        }
    }
    const thinking = [];
    let cursor = 0;
    const addSpan = (startMs, endMs) => {
        if (endMs <= startMs || sameTime(startMs, endMs))
            return;
        thinking.push({
            op: "thinking",
            startMs,
            endMs,
            durationMs: endMs - startMs,
            status: "ok",
        });
    };
    for (const interval of merged) {
        addSpan(cursor, interval.startMs);
        cursor = Math.max(cursor, interval.endMs);
    }
    addSpan(cursor, totalMs);
    return thinking;
}
/** Preserve every tool span and add only the union-complement thinking spans. */
export function buildTraceEvents(tools, totalMs) {
    const events = [...tools, ...computeThinkingSpans(tools, totalMs)];
    return events.sort((left, right) => {
        const byStart = left.startMs - right.startMs;
        if (byStart !== 0)
            return byStart;
        if (left.op === "thinking" && right.op !== "thinking")
            return 1;
        if (right.op === "thinking" && left.op !== "thinking")
            return -1;
        return left.endMs - right.endMs;
    });
}
function validateDigest(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest`);
    }
}
function validateInputSignature(value, label) {
    if (!isRecord(value) || value.schemaVersion !== 1)
        throw new Error(`${label} is invalid`);
    if (!Array.isArray(value.argumentKeys) || value.argumentKeys.some((key) => typeof key !== "string")) {
        throw new Error(`${label}.argumentKeys must be strings`);
    }
    const argumentKeys = value.argumentKeys;
    const sorted = [...argumentKeys].sort();
    if (new Set(sorted).size !== sorted.length || sorted.some((key, index) => key !== argumentKeys[index])) {
        throw new Error(`${label}.argumentKeys must be sorted and unique`);
    }
    validateDigest(value.digest, `${label}.digest`);
    for (const key of ["patternHash", "pathHash", "globHash", "payloadHash"]) {
        if (value[key] !== undefined)
            validateDigest(value[key], `${label}.${key}`);
    }
}
function validateTokenUsage(value) {
    if (!isRecord(value))
        throw new Error("tokenUsage must be an object");
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        if (typeof value[key] !== "number")
            throw new Error(`tokenUsage.${key} must be a number`);
        optionalNumber(value, key);
    }
    optionalNumber(value, "reasoning");
    optionalNumber(value, "costTotal");
}
/** Throws when a trace cannot be consumed safely by the benchmark/report code. */
export function validateTrace(value) {
    if (!isRecord(value))
        throw new Error("trace must be an object");
    if (value.schemaVersion !== TRACE_SCHEMA_VERSION)
        throw new Error("unsupported trace schemaVersion");
    for (const key of [
        "runId",
        "workflowId",
        "comparisonId",
        "repo",
        "repoSha",
        "backendRequested",
        "model",
        "thinking",
    ]) {
        nonEmptyString(value, key);
    }
    const promptHash = nonEmptyString(value, "promptHash");
    if (!/^[a-f0-9]{64}$/u.test(promptHash))
        throw new Error("promptHash must be a lowercase SHA-256 digest");
    if (!Number.isInteger(value.attempt) || value.attempt < 1) {
        throw new Error("attempt must be a positive integer");
    }
    const startedAt = nonEmptyString(value, "startedAt");
    if (!Number.isFinite(Date.parse(startedAt)))
        throw new Error("startedAt must be an ISO timestamp");
    if (typeof value.totalMs !== "number")
        throw new Error("totalMs must be a number");
    assertFiniteTime(value.totalMs, "totalMs");
    if (typeof value.status !== "string" || !RUN_STATUSES.has(value.status)) {
        throw new Error("invalid trace status");
    }
    if (!Array.isArray(value.events))
        throw new Error("events must be an array");
    if (value.tokenUsage !== undefined)
        validateTokenUsage(value.tokenUsage);
    const toolEvents = [];
    const thinkingEvents = [];
    const toolCallIds = new Set();
    for (const [index, candidate] of value.events.entries()) {
        if (!isRecord(candidate))
            throw new Error(`events[${index}] must be an object`);
        if (typeof candidate.op !== "string" || !OPERATIONS.has(candidate.op)) {
            throw new Error(`events[${index}] has an invalid op`);
        }
        if (typeof candidate.startMs !== "number" || typeof candidate.endMs !== "number") {
            throw new Error(`events[${index}] times must be numbers`);
        }
        assertFiniteTime(candidate.startMs, `events[${index}].startMs`);
        assertFiniteTime(candidate.endMs, `events[${index}].endMs`);
        if (candidate.endMs < candidate.startMs)
            throw new Error(`events[${index}] ends before it starts`);
        if (candidate.endMs > value.totalMs && !sameTime(candidate.endMs, value.totalMs)) {
            throw new Error(`events[${index}] exceeds totalMs`);
        }
        if (typeof candidate.durationMs !== "number" || !sameTime(candidate.durationMs, candidate.endMs - candidate.startMs)) {
            throw new Error(`events[${index}] has an invalid durationMs`);
        }
        if (typeof candidate.status !== "string" || !EVENT_STATUSES.has(candidate.status)) {
            throw new Error(`events[${index}] has an invalid status`);
        }
        if (candidate.op === "thinking") {
            if (candidate.status !== "ok")
                throw new Error(`events[${index}] thinking status must be ok`);
            thinkingEvents.push(candidate);
            continue;
        }
        const tool = nonEmptyString(candidate, "tool");
        const toolCallId = nonEmptyString(candidate, "toolCallId");
        if (toolCallIds.has(toolCallId))
            throw new Error(`duplicate toolCallId ${toolCallId}`);
        toolCallIds.add(toolCallId);
        optionalString(candidate, "actualSearchBackend");
        optionalString(candidate, "fallbackReason");
        optionalNumber(candidate, "resultCount");
        if (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean") {
            throw new Error(`events[${index}].truncated must be boolean`);
        }
        if (candidate.inputSignature !== undefined) {
            validateInputSignature(candidate.inputSignature, `events[${index}].inputSignature`);
        }
        if (normalizeToolOperation(tool) !== candidate.op) {
            throw new Error(`events[${index}] op does not match tool`);
        }
        toolEvents.push(candidate);
    }
    const expectedThinking = computeThinkingSpans(toolEvents, value.totalMs);
    const actualThinking = [...thinkingEvents].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    if (actualThinking.length !== expectedThinking.length) {
        throw new Error("thinking spans do not cover the complement of tool time");
    }
    for (let index = 0; index < expectedThinking.length; index += 1) {
        const expected = expectedThinking[index];
        const actual = actualThinking[index];
        if (!expected || !actual || !sameTime(expected.startMs, actual.startMs) || !sameTime(expected.endMs, actual.endMs)) {
            throw new Error("thinking spans do not cover the complement of tool time");
        }
    }
}
/** One operation-level trace recorder. All timestamps come from one monotonic clock. */
export class TraceRecorder {
    metadata;
    now;
    wallNow;
    activeTools = new Map();
    completedToolIds = new Set();
    tools = [];
    origin;
    lastObserved;
    startedAt;
    finalized;
    tokenUsage;
    constructor(metadata, options = {}) {
        this.metadata = { ...metadata };
        this.now = options.now ?? (() => performance.now());
        this.wallNow = options.wallNow ?? (() => new Date());
        validateMetadata(this.metadata);
    }
    get isStarted() {
        return this.origin !== undefined;
    }
    get isFinished() {
        return this.finalized !== undefined;
    }
    /** Idempotent so before_agent_start and agent_start can both establish the same run. */
    begin(at) {
        if (this.finalized)
            throw new Error("trace is already finalized");
        if (this.origin !== undefined)
            return;
        const observed = at ?? this.now();
        assertFiniteTime(observed, "trace start time");
        this.origin = observed;
        this.lastObserved = observed;
        this.startedAt = this.wallNow().toISOString();
    }
    startTool(toolCallId, tool, at, input, cwd) {
        this.assertOpen();
        if (!toolCallId || !tool)
            throw new Error("toolCallId and tool must be non-empty strings");
        if (this.activeTools.has(toolCallId) || this.completedToolIds.has(toolCallId)) {
            throw new Error(`duplicate tool_execution_start for ${toolCallId}`);
        }
        const elapsed = this.observe(at, "tool start time");
        const active = { tool, startMs: elapsed };
        if (input !== undefined)
            active.inputSignature = toolInputSignature(tool, input, cwd);
        this.activeTools.set(toolCallId, active);
    }
    endTool(toolCallId, result, isError, at, expectedTool) {
        this.assertOpen();
        const active = this.activeTools.get(toolCallId);
        if (!active)
            throw new Error(`tool_execution_end without matching start for ${toolCallId}`);
        if (expectedTool !== undefined && expectedTool !== active.tool) {
            throw new Error(`tool name mismatch for ${toolCallId}: ${active.tool} != ${expectedTool}`);
        }
        const endMs = this.observe(at, "tool end time");
        if (endMs < active.startMs)
            throw new Error(`tool_execution_end precedes start for ${toolCallId}`);
        const searchMetadata = readFastGrepMetadata(active.tool, result);
        this.tools.push({
            op: normalizeToolOperation(active.tool),
            tool: active.tool,
            toolCallId,
            startMs: active.startMs,
            endMs,
            durationMs: endMs - active.startMs,
            status: isError ? "error" : "ok",
            ...(active.inputSignature === undefined ? {} : { inputSignature: active.inputSignature }),
            ...searchMetadata,
        });
        this.activeTools.delete(toolCallId);
        this.completedToolIds.add(toolCallId);
    }
    /** Compatibility aliases matching the lifecycle event names. */
    toolStart(toolCallId, tool, at) {
        this.startTool(toolCallId, tool, at);
    }
    toolEnd(toolCallId, result, isError, at, expectedTool) {
        this.endTool(toolCallId, result, isError, at, expectedTool);
    }
    /** Sum final assistant-message usage blocks when Pi/provider events expose them. */
    addTokenUsage(messageOrUsage) {
        this.assertOpen();
        const usage = extractTokenUsage(messageOrUsage);
        if (!usage)
            return;
        if (!this.tokenUsage) {
            this.tokenUsage = { ...usage };
            return;
        }
        this.tokenUsage.input += usage.input;
        this.tokenUsage.output += usage.output;
        this.tokenUsage.cacheRead += usage.cacheRead;
        this.tokenUsage.cacheWrite += usage.cacheWrite;
        this.tokenUsage.totalTokens += usage.totalTokens;
        if (usage.reasoning !== undefined) {
            this.tokenUsage.reasoning = (this.tokenUsage.reasoning ?? 0) + usage.reasoning;
        }
        if (usage.costTotal !== undefined) {
            this.tokenUsage.costTotal = (this.tokenUsage.costTotal ?? 0) + usage.costTotal;
        }
    }
    finish(status = "completed", at) {
        if (this.finalized)
            return this.finalized;
        if (!RUN_STATUSES.has(status))
            throw new Error(`invalid trace status: ${status}`);
        if (this.origin === undefined)
            this.begin(at);
        const totalMs = this.observe(at, "trace end time");
        for (const [toolCallId, active] of this.activeTools) {
            this.tools.push({
                op: normalizeToolOperation(active.tool),
                tool: active.tool,
                toolCallId,
                startMs: active.startMs,
                endMs: totalMs,
                durationMs: totalMs - active.startMs,
                status: "aborted",
                ...(active.inputSignature === undefined ? {} : { inputSignature: active.inputSignature }),
            });
            this.completedToolIds.add(toolCallId);
        }
        this.activeTools.clear();
        const run = {
            schemaVersion: TRACE_SCHEMA_VERSION,
            ...this.metadata,
            startedAt: this.startedAt ?? this.wallNow().toISOString(),
            totalMs,
            status,
            events: buildTraceEvents(this.tools, totalMs),
            ...(this.tokenUsage === undefined ? {} : { tokenUsage: { ...this.tokenUsage } }),
        };
        validateTrace(run);
        this.finalized = run;
        return run;
    }
    assertOpen() {
        if (this.finalized)
            throw new Error("trace is already finalized");
        if (this.origin === undefined)
            throw new Error("trace has not started");
    }
    observe(at, label) {
        if (this.origin === undefined)
            throw new Error("trace has not started");
        const observed = at ?? this.now();
        assertFiniteTime(observed, label);
        if (observed < this.origin || (this.lastObserved !== undefined && observed < this.lastObserved)) {
            throw new Error(`${label} moved backwards on the monotonic clock`);
        }
        this.lastObserved = observed;
        return observed - this.origin;
    }
}
function validateMetadata(metadata) {
    const candidate = { ...metadata };
    for (const key of [
        "runId",
        "workflowId",
        "comparisonId",
        "repo",
        "repoSha",
        "backendRequested",
        "model",
        "thinking",
    ]) {
        nonEmptyString(candidate, key);
    }
    if (!Number.isInteger(metadata.attempt) || metadata.attempt < 1)
        throw new Error("attempt must be a positive integer");
    if (!/^[a-f0-9]{64}$/u.test(metadata.promptHash)) {
        throw new Error("promptHash must be a lowercase SHA-256 digest");
    }
}
/** Write in the destination directory and rename, so readers never see partial JSON. */
export async function writeTraceAtomic(outputPath, trace) {
    validateTrace(trace);
    const absolutePath = path.resolve(outputPath);
    const directory = path.dirname(absolutePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, absolutePath);
    }
    catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
