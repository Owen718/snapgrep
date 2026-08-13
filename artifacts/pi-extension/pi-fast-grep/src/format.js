const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_LINE_CHARS = 500;
function cleanLine(value) {
    return value.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
}
function truncateLine(value) {
    if (value.length <= MAX_LINE_CHARS)
        return { text: value, truncated: false };
    return { text: `${value.slice(0, MAX_LINE_CHARS)}... [truncated]`, truncated: true };
}
function collectDisplayLines(matches) {
    const files = new Map();
    for (const match of matches) {
        let lines = files.get(match.path);
        if (!lines) {
            lines = new Map();
            files.set(match.path, lines);
        }
        const beforeStart = match.lineNumber - match.before.length;
        for (let index = 0; index < match.before.length; index += 1) {
            const lineNumber = beforeStart + index;
            if (!lines.has(lineNumber)) {
                lines.set(lineNumber, { lineNumber, text: match.before[index] ?? "", match: false });
            }
        }
        const matchLines = cleanLine(match.lineText).split("\n");
        for (let index = 0; index < matchLines.length; index += 1) {
            const lineNumber = match.lineNumber + index;
            lines.set(lineNumber, { lineNumber, text: matchLines[index] ?? "", match: true });
        }
        const afterStart = match.lineNumber + Math.max(1, matchLines.length);
        for (let index = 0; index < match.after.length; index += 1) {
            const lineNumber = afterStart + index;
            if (!lines.has(lineNumber)) {
                lines.set(lineNumber, { lineNumber, text: match.after[index] ?? "", match: false });
            }
        }
    }
    return files;
}
function backendSummary(metadata) {
    const total = metadata.totalMatchesExact === false
        ? `>=${metadata.totalMatches}`
        : String(metadata.totalMatches);
    const pieces = [
        `backend=${metadata.actualBackend}`,
        `indexed=${metadata.indexFilesConsidered ?? 0} files`,
        `realtime=${metadata.realtimeFiles} files`,
        `matches=${metadata.displayedMatches}/${total}`,
        `total=${metadata.timings.totalMs.toFixed(1)}ms`,
    ];
    if (metadata.fallbackReason)
        pieces.push(`fallback=${metadata.fallbackReason}`);
    return `[fast_grep: ${pieces.join(", ")}]`;
}
export function formatSearchResult(result, request) {
    const output = [];
    let linesTruncated = false;
    const display = collectDisplayLines(result.matches);
    for (const [filePath, lines] of [...display].sort(([a], [b]) => a.localeCompare(b))) {
        let previousLine;
        for (const line of [...lines.values()].sort((a, b) => a.lineNumber - b.lineNumber)) {
            if (previousLine !== undefined && line.lineNumber > previousLine + 1)
                output.push("--");
            const rendered = truncateLine(cleanLine(line.text));
            linesTruncated ||= rendered.truncated;
            const separator = line.match ? ":" : "-";
            output.push(`${filePath}${separator}${line.lineNumber}${separator} ${rendered.text}`);
            previousLine = line.lineNumber;
        }
    }
    if (output.length === 0) {
        output.push("No matches found");
        if (result.metadata.actualBackend === "zoekt") {
            output.push("If this conflicts with known repository evidence, verify once with `rg --no-config` in bash.");
        }
    }
    const notices = [];
    if (result.metadata.truncated) {
        const limit = request.limit ?? result.metadata.displayedMatches;
        const total = result.metadata.totalMatchesExact === false
            ? `at least ${result.metadata.totalMatches}`
            : String(result.metadata.totalMatches);
        notices.push(`Showing ${result.metadata.displayedMatches} of ${total} matches (limit ${limit}). Increase limit or narrow path/glob`);
    }
    if (linesTruncated)
        notices.push(`Some lines were truncated to ${MAX_LINE_CHARS} characters; use read for full text`);
    if (notices.length > 0)
        output.push("", `[${notices.join(". ")}]`);
    output.push("", backendSummary(result.metadata));
    let text = output.join("\n");
    let outputTruncated = false;
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
        const kept = [];
        let bytes = 0;
        for (const line of text.split("\n")) {
            const lineBytes = Buffer.byteLength(`${line}\n`);
            if (bytes + lineBytes > MAX_OUTPUT_BYTES - 128)
                break;
            kept.push(line);
            bytes += lineBytes;
        }
        kept.push("", `[Output truncated at ${Math.round(MAX_OUTPUT_BYTES / 1024)} KiB; narrow path/glob]`);
        text = kept.join("\n");
        outputTruncated = true;
    }
    const details = {
        matches: result.matches,
        metadata: result.metadata,
    };
    if (result.metadata.truncated && request.limit !== null && request.limit !== undefined) {
        details.matchLimitReached = request.limit;
    }
    if (linesTruncated)
        details.linesTruncated = true;
    if (outputTruncated)
        details.outputTruncated = true;
    return { text, details };
}
