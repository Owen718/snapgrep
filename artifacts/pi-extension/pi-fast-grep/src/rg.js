import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
const DEFAULT_LIMIT = 100;
// Windows has a much smaller command-line limit than Unix. Keeping batches below
// 24 KiB leaves room for the executable, environment expansion, and search flags.
const CANDIDATE_ARGV_BUDGET = 24 * 1024;
const EXCLUDED_DIRECTORIES = [".git", ".pi/index", ".fast-grep"];
/** Run ripgrep with the same semantics used by both the normal and fallback backends. */
export async function runRipgrep(cwd, request, options = {}) {
    const startedAt = performance.now();
    throwIfAborted(options.signal);
    const repoRoot = path.resolve(cwd);
    const searchRoot = path.resolve(repoRoot, request.path ?? ".");
    const context = normalizeNonNegativeInteger(request.context);
    const beforeContext = normalizeNonNegativeInteger(request.beforeContext ?? context);
    const afterContext = normalizeNonNegativeInteger(request.afterContext ?? context);
    const requestedCandidates = mergeCandidates(options);
    const actualBackend = options.actualBackend ?? "rg";
    const requestedBackend = options.requestedBackend ?? (actualBackend === "rg" ? "normal" : "auto");
    if (isExplicitlyExcluded(repoRoot, searchRoot)) {
        return emptyResult(startedAt, actualBackend, requestedBackend);
    }
    let targets;
    if (requestedCandidates !== undefined) {
        targets = normalizeCandidates(repoRoot, searchRoot, requestedCandidates);
        if (targets.length === 0) {
            return emptyResult(startedAt, actualBackend, requestedBackend);
        }
        // rg deliberately searches explicitly named files even when they are hidden,
        // ignored, or rejected by --glob. Enumerate the eligible file universe first
        // so candidate verification has exactly the same filtering as a tree search.
        const eligible = options.eligiblePaths ?? (await listRipgrepFiles(repoRoot, request, options.signal));
        const eligibleKeys = process.platform === "win32" ? new Set([...eligible].map(eligiblePathKey)) : eligible;
        targets = targets.filter((candidate) => eligibleKeys.has(eligiblePathKey(toPosixPath(path.relative(repoRoot, candidate)))));
        if (targets.length === 0) {
            return emptyResult(startedAt, actualBackend, requestedBackend);
        }
    }
    else {
        targets = [searchRoot];
    }
    const batches = requestedCandidates === undefined ? [targets] : chunkCandidates(targets);
    const parsedBatches = [];
    for (const batch of batches) {
        throwIfAborted(options.signal);
        const args = buildArguments(request, beforeContext, afterContext, batch);
        const events = await executeRipgrep(repoRoot, args, options.signal);
        parsedBatches.push(parseEvents(repoRoot, events));
    }
    const allLines = mergeLineMaps(parsedBatches.map((batch) => batch.linesByPath));
    const uniqueMatches = deduplicateMatches(parsedBatches.flatMap((batch) => batch.matches));
    uniqueMatches.sort(compareMatches);
    const matches = uniqueMatches.map((match) => withContext(match, allLines.get(match.absolutePath), beforeContext, afterContext));
    const totalMatches = matches.length;
    const limit = normalizeLimit(request.limit);
    const displayed = limit === null ? matches : matches.slice(0, limit);
    const totalMs = performance.now() - startedAt;
    return {
        matches: displayed,
        metadata: {
            requestedBackend,
            actualBackend,
            dirtyFiles: 0,
            realtimeFiles: 0,
            totalMatches,
            totalMatchesExact: true,
            displayedMatches: displayed.length,
            truncated: displayed.length < totalMatches,
            timings: { totalMs },
        },
    };
}
/** List files eligible for a request as repo-relative POSIX paths. */
export async function listRipgrepFiles(cwd, request, signal) {
    throwIfAborted(signal);
    const repoRoot = path.resolve(cwd);
    const searchRoot = path.resolve(repoRoot, request.path ?? ".");
    if (isExplicitlyExcluded(repoRoot, searchRoot))
        return new Set();
    return listEligibleFiles(repoRoot, searchRoot, request, signal);
}
async function listEligibleFiles(cwd, searchRoot, request, signal) {
    const args = ["--files", "--no-config", "--null", "--no-require-git"];
    if (request.hidden !== false)
        args.push("--hidden");
    if (request.noIgnore)
        args.push("--no-ignore");
    if (request.glob !== undefined)
        args.push("--glob", request.glob);
    for (const directory of EXCLUDED_DIRECTORIES) {
        args.push("--glob", `!**/${directory}/**`);
    }
    args.push("--", searchRoot);
    const output = await executeRipgrepFiles(cwd, args, signal);
    const eligible = new Set();
    let start = 0;
    for (let index = 0; index <= output.length; index += 1) {
        if (index !== output.length && output[index] !== 0)
            continue;
        if (index > start) {
            const listed = output.subarray(start, index).toString("utf8");
            const absolutePath = path.isAbsolute(listed) ? path.normalize(listed) : path.resolve(cwd, listed);
            eligible.add(toPosixPath(path.relative(cwd, absolutePath)) || path.basename(absolutePath));
        }
        start = index + 1;
    }
    return eligible;
}
async function executeRipgrepFiles(cwd, args, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const child = spawn("rg", args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks = [];
        let stderr = "";
        let settled = false;
        let aborted = false;
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = () => {
            aborted = true;
            child.kill("SIGTERM");
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
            finish(() => reject(new Error(`Failed to run ripgrep: ${error.message}`, { cause: error })));
        });
        child.once("close", (code) => {
            if (aborted || signal?.aborted) {
                finish(() => reject(abortError()));
                return;
            }
            if (code !== 0 && code !== 1) {
                const detail = stderr.trim();
                const message = detail.length > 0 ? detail : `ripgrep exited with code ${String(code)}`;
                finish(() => reject(new Error(message)));
                return;
            }
            finish(() => resolve(Buffer.concat(chunks)));
        });
    });
}
function buildArguments(request, beforeContext, afterContext, targets) {
    const args = ["--no-config", "--json", "--color", "never", "--line-number"];
    if (request.hidden !== false)
        args.push("--hidden");
    // A search root need not itself be a Git worktree (fixtures, extracted source,
    // and monorepo subtrees are common), but its ignore files should still apply.
    args.push("--no-require-git");
    if (request.noIgnore)
        args.push("--no-ignore");
    if (request.ignoreCase)
        args.push("--ignore-case");
    if (request.literal)
        args.push("--fixed-strings");
    if (request.multiline)
        args.push("--multiline");
    if (request.glob !== undefined)
        args.push("--glob", request.glob);
    // These are implementation data, not user source. Keep the exclusions after
    // the user glob so an inclusive user glob cannot opt them back in.
    for (const directory of EXCLUDED_DIRECTORIES) {
        // rg receives an absolute traversal root here, so the recursive prefix is
        // needed for the glob to match that root's relative walk paths.
        args.push("--glob", `!**/${directory}/**`);
    }
    if (beforeContext > 0)
        args.push("--before-context", String(beforeContext));
    if (afterContext > 0)
        args.push("--after-context", String(afterContext));
    args.push("--", request.pattern, ...targets);
    return args;
}
async function executeRipgrep(cwd, args, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const child = spawn("rg", args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const decoder = new StringDecoder("utf8");
        let stdoutBuffer = "";
        let stderr = "";
        let settled = false;
        let aborted = false;
        let parseError;
        const events = [];
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = () => {
            aborted = true;
            child.kill("SIGTERM");
        };
        const consumeLine = (line) => {
            if (line.length === 0 || parseError !== undefined)
                return;
            try {
                events.push(JSON.parse(line));
            }
            catch (error) {
                parseError = new Error(`Failed to parse ripgrep JSON: ${error instanceof Error ? error.message : String(error)}`);
                child.kill("SIGTERM");
            }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        child.stdout.on("data", (chunk) => {
            stdoutBuffer += decoder.write(chunk);
            let newline = stdoutBuffer.indexOf("\n");
            while (newline >= 0) {
                consumeLine(stdoutBuffer.slice(0, newline));
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                newline = stdoutBuffer.indexOf("\n");
            }
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
            finish(() => reject(new Error(`Failed to run ripgrep: ${error.message}`, { cause: error })));
        });
        child.once("close", (code) => {
            stdoutBuffer += decoder.end();
            if (stdoutBuffer.length > 0)
                consumeLine(stdoutBuffer);
            if (aborted || signal?.aborted) {
                finish(() => reject(abortError()));
                return;
            }
            if (parseError !== undefined) {
                finish(() => reject(parseError));
                return;
            }
            if (code !== 0 && code !== 1) {
                const detail = stderr.trim();
                const message = detail.length > 0 ? detail : `ripgrep exited with code ${String(code)}`;
                finish(() => reject(new Error(message)));
                return;
            }
            finish(() => resolve(events));
        });
    });
}
function parseEvents(cwd, events) {
    const matches = [];
    const linesByPath = new Map();
    for (const event of events) {
        if (!isRecord(event) || (event.type !== "match" && event.type !== "context"))
            continue;
        const data = parseEventData(event.data);
        if (data === undefined)
            continue;
        const absolutePath = path.isAbsolute(data.path) ? path.normalize(data.path) : path.resolve(cwd, data.path);
        const parsedLines = splitEventLines(data.lines, data.lineNumber);
        let fileLines = linesByPath.get(absolutePath);
        if (fileLines === undefined) {
            fileLines = new Map();
            linesByPath.set(absolutePath, fileLines);
        }
        for (const line of parsedLines)
            fileLines.set(line.lineNumber, line.text);
        if (event.type === "context")
            continue;
        const ranges = data.submatches.map((submatch) => ({
            absoluteStart: data.absoluteOffset + submatch.start,
            absoluteEnd: data.absoluteOffset + submatch.end,
            lineStart: submatch.start,
            lineEnd: submatch.end,
        }));
        matches.push({
            absolutePath,
            path: toPosixPath(path.relative(cwd, absolutePath)) || path.basename(absolutePath),
            lineNumber: data.lineNumber,
            lineText: stripFinalLineEnding(data.lines),
            lineCount: Math.max(1, parsedLines.length),
            ranges,
        });
    }
    return { matches, linesByPath };
}
function parseEventData(value) {
    if (!isRecord(value))
        return undefined;
    const eventPath = decodeTextField(value.path);
    const lines = decodeTextField(value.lines);
    if (eventPath === undefined ||
        lines === undefined ||
        typeof value.line_number !== "number" ||
        typeof value.absolute_offset !== "number" ||
        !Array.isArray(value.submatches)) {
        return undefined;
    }
    const submatches = [];
    for (const submatch of value.submatches) {
        if (isRecord(submatch) &&
            typeof submatch.start === "number" &&
            typeof submatch.end === "number") {
            submatches.push({ start: submatch.start, end: submatch.end });
        }
    }
    return {
        path: eventPath,
        lines,
        lineNumber: value.line_number,
        absoluteOffset: value.absolute_offset,
        submatches,
    };
}
function decodeTextField(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.text === "string")
        return value.text;
    if (typeof value.bytes === "string")
        return Buffer.from(value.bytes, "base64").toString("utf8");
    return undefined;
}
function splitEventLines(text, firstLineNumber) {
    const withoutTerminator = stripFinalLineEnding(text);
    return withoutTerminator.split(/\r\n|\n|\r/).map((line, index) => ({
        lineNumber: firstLineNumber + index,
        text: line,
    }));
}
function stripFinalLineEnding(text) {
    if (text.endsWith("\r\n"))
        return text.slice(0, -2);
    if (text.endsWith("\n") || text.endsWith("\r"))
        return text.slice(0, -1);
    return text;
}
function withContext(match, lines, beforeCount, afterCount) {
    const before = [];
    const after = [];
    if (lines !== undefined) {
        for (let lineNumber = match.lineNumber - beforeCount; lineNumber < match.lineNumber; lineNumber += 1) {
            const line = lines.get(lineNumber);
            if (line !== undefined)
                before.push(line);
        }
        const firstAfterLine = match.lineNumber + match.lineCount;
        for (let lineNumber = firstAfterLine; lineNumber < firstAfterLine + afterCount; lineNumber += 1) {
            const line = lines.get(lineNumber);
            if (line !== undefined)
                after.push(line);
        }
    }
    return {
        path: match.path,
        absolutePath: match.absolutePath,
        lineNumber: match.lineNumber,
        lineText: match.lineText,
        ranges: match.ranges,
        before,
        after,
    };
}
function mergeCandidates(options) {
    if (options.candidates === undefined)
        return options.candidatePaths;
    if (options.candidatePaths === undefined)
        return options.candidates;
    return [...options.candidates, ...options.candidatePaths];
}
function normalizeCandidates(cwd, searchRoot, candidates) {
    const result = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const absolutePath = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
        if (!isWithin(searchRoot, absolutePath) || isExplicitlyExcluded(cwd, absolutePath))
            continue;
        const key = pathKey(absolutePath);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(absolutePath);
    }
    return result;
}
function chunkCandidates(candidates) {
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const candidate of candidates) {
        const candidateBytes = Buffer.byteLength(candidate, "utf8") + 1;
        if (batch.length > 0 && bytes + candidateBytes > CANDIDATE_ARGV_BUDGET) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(candidate);
        bytes += candidateBytes;
    }
    if (batch.length > 0)
        batches.push(batch);
    return batches;
}
function mergeLineMaps(maps) {
    const result = new Map();
    for (const source of maps) {
        for (const [filePath, lines] of source) {
            let destination = result.get(filePath);
            if (destination === undefined) {
                destination = new Map();
                result.set(filePath, destination);
            }
            for (const [lineNumber, line] of lines)
                destination.set(lineNumber, line);
        }
    }
    return result;
}
function deduplicateMatches(matches) {
    const result = [];
    const seen = new Set();
    for (const match of matches) {
        const rangeKey = match.ranges
            .map((range) => `${range.absoluteStart}:${range.absoluteEnd}`)
            .join(",");
        const key = `${match.absolutePath}\0${match.lineNumber}\0${rangeKey}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(match);
    }
    return result;
}
function compareMatches(left, right) {
    if (left.path < right.path)
        return -1;
    if (left.path > right.path)
        return 1;
    if (left.lineNumber !== right.lineNumber)
        return left.lineNumber - right.lineNumber;
    return (left.ranges[0]?.absoluteStart ?? 0) - (right.ranges[0]?.absoluteStart ?? 0);
}
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function isExplicitlyExcluded(cwd, target) {
    const parts = toPosixPath(path.relative(cwd, target)).split("/");
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === ".git" || part === ".fast-grep")
            return true;
        if (part === ".pi" && parts[index + 1] === "index")
            return true;
    }
    return false;
}
function normalizeNonNegativeInteger(value) {
    if (value === undefined || !Number.isFinite(value))
        return 0;
    return Math.max(0, Math.floor(value));
}
function normalizeLimit(value) {
    if (value === null)
        return null;
    if (value === undefined)
        return DEFAULT_LIMIT;
    if (!Number.isFinite(value))
        throw new Error("limit must be a finite number or null");
    return Math.max(0, Math.floor(value));
}
function emptyResult(startedAt, actualBackend, requestedBackend) {
    return {
        matches: [],
        metadata: {
            requestedBackend,
            actualBackend,
            dirtyFiles: 0,
            realtimeFiles: 0,
            totalMatches: 0,
            totalMatchesExact: true,
            displayedMatches: 0,
            truncated: false,
            timings: { totalMs: performance.now() - startedAt },
        },
    };
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
function abortError() {
    const error = new Error("Operation aborted");
    error.name = "AbortError";
    return error;
}
function toPosixPath(value) {
    return value.split(path.sep).join("/");
}
function pathKey(value) {
    return process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
}
function eligiblePathKey(value) {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
