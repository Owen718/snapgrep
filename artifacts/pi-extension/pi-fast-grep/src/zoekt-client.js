import { isUtf8 } from "node:buffer";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FILES = 10_000;
const MAX_EXACT_MATCH_LINES = 1_000_000;
export class ZoektClientError extends Error {
    name = "ZoektClientError";
    constructor(message, options) {
        super(message, options);
    }
}
export class ZoektHttpError extends ZoektClientError {
    name = "ZoektHttpError";
    status;
    constructor(status, message) {
        super(`Zoekt HTTP ${status}: ${message}`);
        this.status = status;
    }
}
export class ZoektApiError extends ZoektClientError {
    name = "ZoektApiError";
}
export class ZoektResponseError extends ZoektClientError {
    name = "ZoektResponseError";
}
export class ZoektTimeoutError extends ZoektClientError {
    name = "ZoektTimeoutError";
    timeoutMs;
    constructor(timeoutMs) {
        super(`Zoekt request timed out after ${timeoutMs} ms`);
        this.timeoutMs = timeoutMs;
    }
}
export class ZoektNetworkError extends ZoektClientError {
    name = "ZoektNetworkError";
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteNumber(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function requirePositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}
function abortSignalFrom(input) {
    if (input === undefined) {
        return undefined;
    }
    if (typeof input.aborted === "boolean") {
        return input;
    }
    return input.signal;
}
function signalIsAborted(signal) {
    return signal?.aborted === true;
}
function throwAbortReason(signal) {
    if (signal.reason instanceof Error) {
        throw signal.reason;
    }
    const error = new Error("Zoekt request aborted", { cause: signal.reason });
    error.name = "AbortError";
    throw error;
}
function normalizeFileName(value) {
    if (typeof value !== "string" || value.length === 0) {
        throw new ZoektResponseError("Zoekt returned a file without a valid FileName");
    }
    let normalized = value.replace(/\\/gu, "/");
    while (normalized.startsWith("./")) {
        normalized = normalized.slice(2);
    }
    if (normalized.length === 0
        || normalized.startsWith("/")
        || /^[A-Za-z]:\//u.test(normalized)
        || normalized.split("/").includes("..")
        || normalized.includes("\0")) {
        throw new ZoektResponseError(`Zoekt returned a non-relative FileName: ${JSON.stringify(value)}`);
    }
    return normalized;
}
function nonNegativeSafeInteger(value) {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : undefined;
}
function positiveSafeInteger(value) {
    const integer = nonNegativeSafeInteger(value);
    return integer !== undefined && integer > 0 ? integer : undefined;
}
function decodeCanonicalBase64(value) {
    if (typeof value !== "string"
        || value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        return undefined;
    }
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value ? decoded : undefined;
}
function parseExactMatches(result, files, literal) {
    if (nonNegativeSafeInteger(result.Crashes) !== 0
        || nonNegativeSafeInteger(result.FilesSkipped) !== 0
        || nonNegativeSafeInteger(result.FlushReason) !== 0
        || nonNegativeSafeInteger(result.FileCount) !== files.length) {
        return undefined;
    }
    const literalBytes = Buffer.from(literal, "utf8");
    const matches = [];
    const carriageReturnPaths = new Set();
    const seenFiles = new Set();
    let parsedLineMatches = 0;
    for (const file of files) {
        const fileName = normalizeFileName(file.FileName);
        if (seenFiles.has(fileName))
            return undefined;
        seenFiles.add(fileName);
        if (file.ChunkMatches !== undefined
            && file.ChunkMatches !== null
            && (!Array.isArray(file.ChunkMatches) || file.ChunkMatches.length > 0)) {
            return undefined;
        }
        if (file.LineMatches !== undefined
            && file.LineMatches !== null
            && !Array.isArray(file.LineMatches)) {
            return undefined;
        }
        const lineMatches = (file.LineMatches ?? []);
        for (const rawLineMatch of lineMatches) {
            parsedLineMatches += 1;
            if (!isObject(rawLineMatch) || rawLineMatch.FileName !== false)
                return undefined;
            const line = decodeCanonicalBase64(rawLineMatch.Line);
            const lineStart = nonNegativeSafeInteger(rawLineMatch.LineStart);
            const lineEnd = nonNegativeSafeInteger(rawLineMatch.LineEnd);
            const lineNumber = positiveSafeInteger(rawLineMatch.LineNumber);
            if (line === undefined
                || lineStart === undefined
                || lineEnd !== lineStart + line.length
                || lineNumber === undefined
                || !isUtf8(line)
                || line.includes(0)) {
                return undefined;
            }
            const firstLf = line.indexOf(10);
            if (firstLf !== -1 && firstLf !== line.length - 1)
                return undefined;
            if (!Array.isArray(rawLineMatch.LineFragments) || rawLineMatch.LineFragments.length === 0) {
                return undefined;
            }
            if (line.includes(13)) {
                carriageReturnPaths.add(fileName);
                continue;
            }
            const ranges = [];
            let previousEnd = -1;
            for (const rawFragment of rawLineMatch.LineFragments) {
                if (!isObject(rawFragment))
                    return undefined;
                const lineOffset = nonNegativeSafeInteger(rawFragment.LineOffset);
                const absoluteStart = nonNegativeSafeInteger(rawFragment.Offset);
                const matchLength = positiveSafeInteger(rawFragment.MatchLength);
                if (lineOffset === undefined
                    || absoluteStart === undefined
                    || matchLength !== literalBytes.length
                    || absoluteStart !== lineStart + lineOffset
                    || lineOffset < previousEnd
                    || lineOffset + matchLength > line.length
                    || !line.subarray(lineOffset, lineOffset + matchLength).equals(literalBytes)) {
                    return undefined;
                }
                ranges.push({
                    absoluteStart,
                    absoluteEnd: absoluteStart + matchLength,
                    lineStart: lineOffset,
                    lineEnd: lineOffset + matchLength,
                });
                previousEnd = lineOffset + matchLength;
            }
            const lineWithoutLf = line[line.length - 1] === 10
                ? line.subarray(0, line.length - 1)
                : line;
            matches.push({
                path: fileName,
                lineNumber,
                lineText: lineWithoutLf.toString("utf8"),
                ranges,
            });
        }
    }
    return nonNegativeSafeInteger(result.MatchCount) === parsedLineMatches
        ? { matches, carriageReturnPaths: [...carriageReturnPaths] }
        : undefined;
}
function baseVersion(files) {
    const baseFiles = files.filter((file) => typeof file.Repository !== "string" || !file.Repository.startsWith("fast-grep-overlay/"));
    if (baseFiles.length === 0)
        return { state: "no_base_files" };
    let expected;
    for (const file of baseFiles) {
        if (typeof file.Version !== "string" || file.Version.length === 0) {
            return { state: "missing" };
        }
        if (expected === undefined) {
            expected = file.Version;
        }
        else if (file.Version !== expected) {
            return { state: "mixed" };
        }
    }
    return { state: "consistent", ...(expected === undefined ? {} : { version: expected }) };
}
function apiErrorMessage(payload) {
    if (!isObject(payload) || typeof payload.Error !== "string") {
        return undefined;
    }
    return payload.Error;
}
export class ZoektClient {
    baseUrl;
    timeoutMs;
    maxFiles;
    fetchImpl;
    constructor(options) {
        const normalizedOptions = typeof options === "string"
            ? { baseUrl: options }
            : options;
        const parsed = new URL(normalizedOptions.baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new TypeError("Zoekt baseUrl must use http or https");
        }
        this.baseUrl = normalizedOptions.baseUrl.replace(/\/+$/u, "");
        this.timeoutMs = requirePositiveInteger(normalizedOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
        this.maxFiles = requirePositiveInteger(normalizedOptions.maxFiles ?? DEFAULT_MAX_FILES, "maxFiles");
        this.fetchImpl = normalizedOptions.fetchImpl ?? globalThis.fetch;
        if (typeof this.fetchImpl !== "function") {
            throw new TypeError("A fetch implementation is required");
        }
    }
    async health(options) {
        const { payload } = await this.requestJson("/healthz", { method: "GET" }, abortSignalFrom(options));
        if (!isObject(payload) || typeof payload.Crashes !== "number") {
            throw new ZoektResponseError("Zoekt health response is missing numeric Crashes");
        }
        return Number.isFinite(payload.Crashes) && payload.Crashes === 0;
    }
    async healthCheck(options) {
        return this.health(options);
    }
    async isHealthy(options) {
        return this.health(options);
    }
    async search(input, options = {}) {
        const exactMatchQuery = typeof input === "string" ? undefined : input.exactMatchQuery;
        const query = exactMatchQuery ?? (typeof input === "string" ? input : input.query);
        const exactLiteral = exactMatchQuery === undefined || typeof input === "string"
            ? undefined
            : input.mandatoryLiteral;
        if (query.length === 0) {
            throw new TypeError("Zoekt query must not be empty");
        }
        const normalizedOptions = typeof options === "number"
            ? { maxFiles: options }
            : options;
        const maxFiles = requirePositiveInteger(normalizedOptions.maxFiles ?? this.maxFiles, "maxFiles");
        // Fetch one sentinel document beyond the caller's limit. This turns an
        // otherwise silent display cap into an explicit `truncated` result.
        const requestedFiles = maxFiles === Number.MAX_SAFE_INTEGER ? maxFiles : maxFiles + 1;
        const startedAt = process.hrtime.bigint();
        const { payload, jsonDecodeMs } = await this.requestJson("/api/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                Q: query,
                Opts: {
                    MaxDocDisplayCount: requestedFiles,
                    ...(exactLiteral === undefined
                        ? {}
                        : {
                            MaxMatchDisplayCount: MAX_EXACT_MATCH_LINES + 1,
                            ShardMaxMatchCount: MAX_EXACT_MATCH_LINES + 1,
                            TotalMaxMatchCount: MAX_EXACT_MATCH_LINES + 1,
                        }),
                    NumContextLines: 0,
                },
            }),
        }, normalizedOptions.signal);
        const roundTripMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        if (!isObject(payload) || !isObject(payload.Result)) {
            throw new ZoektResponseError("Zoekt search response is missing Result");
        }
        const result = payload.Result;
        if (result.Files !== null && result.Files !== undefined && !Array.isArray(result.Files)) {
            throw new ZoektResponseError("Zoekt Result.Files must be an array or null");
        }
        const rawFiles = (result.Files ?? []);
        const fileObjects = rawFiles.map((file) => {
            if (!isObject(file)) {
                throw new ZoektResponseError("Zoekt Result.Files contains a non-object entry");
            }
            return file;
        });
        const uniqueFiles = [];
        const seen = new Set();
        for (const file of fileObjects) {
            const fileName = normalizeFileName(file.FileName);
            if (!seen.has(fileName)) {
                seen.add(fileName);
                uniqueFiles.push(fileName);
            }
        }
        const filesSkipped = finiteNumber(result.FilesSkipped);
        const flushReason = finiteNumber(result.FlushReason);
        const reportedFileCount = finiteNumber(result.FileCount, rawFiles.length);
        const truncated = uniqueFiles.length > maxFiles
            || rawFiles.length > maxFiles
            || filesSkipped > 0
            || flushReason !== 0
            || reportedFileCount > rawFiles.length;
        const files = uniqueFiles.slice(0, maxFiles);
        const exact = exactLiteral === undefined || truncated
            ? undefined
            : parseExactMatches(result, fileObjects, exactLiteral);
        const version = baseVersion(fileObjects);
        const serverDurationNs = finiteNumber(result.Duration, Number.NaN);
        const serverDurationMs = Number.isFinite(serverDurationNs) && serverDurationNs >= 0
            ? serverDurationNs / 1_000_000
            : undefined;
        const transportSerializationMs = Math.max(0, roundTripMs - (serverDurationMs ?? 0) - jsonDecodeMs);
        return {
            files,
            ...(exact === undefined
                ? {}
                : {
                    exactMatches: exact.matches,
                    exactMatchCarriageReturnPaths: exact.carriageReturnPaths,
                }),
            baseVersionState: version.state,
            filesConsidered: finiteNumber(result.FilesConsidered),
            filesLoaded: finiteNumber(result.FilesLoaded),
            matchCount: finiteNumber(result.MatchCount),
            durationMs: roundTripMs,
            roundTripMs,
            ...(serverDurationMs === undefined ? {} : { serverDurationMs }),
            jsonDecodeMs,
            transportSerializationMs,
            truncated,
            ...(version.version === undefined ? {} : { indexedCommit: version.version }),
        };
    }
    async searchCandidates(input, options = {}) {
        return this.search(input, options);
    }
    async requestJson(path, init, externalSignal) {
        if (externalSignal?.aborted === true) {
            throwAbortReason(externalSignal);
        }
        const controller = new AbortController();
        let timedOut = false;
        const onExternalAbort = () => {
            if (!controller.signal.aborted && externalSignal !== undefined) {
                controller.abort(externalSignal.reason);
            }
        };
        externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
        const timeout = setTimeout(() => {
            if (!controller.signal.aborted) {
                timedOut = true;
                controller.abort();
            }
        }, this.timeoutMs);
        timeout.unref();
        try {
            let response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                    ...init,
                    signal: controller.signal,
                });
            }
            catch (error) {
                if (timedOut) {
                    throw new ZoektTimeoutError(this.timeoutMs);
                }
                if (signalIsAborted(externalSignal)) {
                    throwAbortReason(externalSignal);
                }
                throw new ZoektNetworkError("Zoekt request failed", { cause: error });
            }
            let body;
            try {
                body = await response.text();
            }
            catch (error) {
                if (timedOut) {
                    throw new ZoektTimeoutError(this.timeoutMs);
                }
                if (signalIsAborted(externalSignal)) {
                    throwAbortReason(externalSignal);
                }
                throw new ZoektNetworkError("Failed to read Zoekt response", { cause: error });
            }
            let payload;
            const jsonDecodeStartedAt = process.hrtime.bigint();
            try {
                payload = JSON.parse(body);
            }
            catch (error) {
                if (!response.ok) {
                    throw new ZoektHttpError(response.status, body || response.statusText);
                }
                throw new ZoektResponseError("Zoekt returned invalid JSON", { cause: error });
            }
            const jsonDecodeMs = Number(process.hrtime.bigint() - jsonDecodeStartedAt) / 1_000_000;
            const serverError = apiErrorMessage(payload);
            if (!response.ok) {
                throw new ZoektHttpError(response.status, serverError ?? response.statusText);
            }
            if (serverError !== undefined) {
                throw new ZoektApiError(`Zoekt API error: ${serverError}`);
            }
            return { payload, jsonDecodeMs };
        }
        finally {
            clearTimeout(timeout);
            externalSignal?.removeEventListener("abort", onExternalAbort);
        }
    }
}
