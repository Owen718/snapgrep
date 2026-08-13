/**
 * A DeepSeek Harness plugin that answers the `grep` tool from the indexed
 * kernel instead of spawning ripgrep.
 *
 * The harness ships `@deepseek-ai/dsh-tool-fs-search`, which spawns the
 * packaged ripgrep binary through `ctx.subprocess.spawn()` for every call. That
 * pays a process launch plus a full scan each time. This plugin registers a
 * tool under the same name so the kernel answers instead, and keeps the exact
 * output shape the harness expects: `{ matches: [{ path, lineNumber, line }] }`.
 *
 * Load this after the built-in search suite so the later registration wins.
 *
 * Correctness is unchanged: any query the index cannot serve exactly falls back
 * to a full ripgrep run inside the engine, so a match set is never approximated.
 *
 * @module snapgrep/dsh
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolvePackagedKernelAddonPath } from "./extension.js";
import { KernelMutationFeed, OptInKernelEngine } from "./kernel-engine.js";
import { runRipgrep } from "./rg.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = "snapgrep";
/** The harness services this plugin registers into. */
export const inject = ["tools"];
/** Matches the built-in grep tool's inline cap so paging behaviour is unchanged. */
const DEFAULT_MAX_MATCHES = 250;
/**
 * Harness tools known to leave the workspace untouched. Anything absent is
 * assumed to write, which costs an index rebuild but can never serve a stale
 * result — the safe direction to be wrong in. Subagents and MCP tools are
 * deliberately not listed: what they do is not knowable from here.
 */
const READ_ONLY_TOOLS = new Set([
    "grep",
    "glob",
    "read",
    "ls",
    "find",
    "todo_read",
    "ask_user",
    "web_search",
    "web_fetch",
]);
function mayMutate(toolName) {
    return !READ_ONLY_TOOLS.has(toolName);
}
/**
 * Render matches the way the harness's own grep tool does: a found count, then
 * each file's path followed by one `Line N: <text>` row per match, in first-seen
 * order. Keeping this identical matters because the model was trained against
 * the built-in tool's shape.
 */
function formatMatches(matches) {
    if (matches.length === 0)
        return "No matches found.";
    const byFile = new Map();
    for (const match of matches) {
        const group = byFile.get(match.path);
        if (group === undefined)
            byFile.set(match.path, [match]);
        else
            group.push(match);
    }
    const blocks = [];
    for (const [file, group] of byFile) {
        const rows = group.map((match) => `Line ${match.lineNumber}: ${match.line}`);
        blocks.push([file, ...rows].join("\n"));
    }
    const header = matches.length === 1 ? "Found 1 match" : `Found ${matches.length} matches`;
    return [`${header}:`, "", blocks.join("\n\n")].join("\n");
}
/**
 * Where a workspace's index lives.
 *
 * Never inside the workspace. The kernel only serves a clean Git snapshot, so
 * an index written under the repository would show up as an untracked file and
 * disqualify every subsequent search — the index would switch itself off after
 * the first query. Pi's own layout avoids this because `.pi/` is conventionally
 * gitignored there; nothing guarantees that in an arbitrary repository.
 */
function indexPathFor(root) {
    const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
    return path.join(base, "snapgrep", `${digest}.pfg`);
}
/**
 * One engine per workspace, started on first use. The harness can switch
 * sessions within a process, so the cache is keyed by resolved workdir rather
 * than assuming a single root.
 *
 * A workspace the index cannot serve resolves to `undefined` instead of
 * throwing. That is the common case, not an edge case: the kernel requires a
 * clean Git snapshot, and real workspaces routinely carry uncommitted edits or
 * stray files. Those searches run on ripgrep and stay correct; only the
 * acceleration is lost.
 */
class EngineCache {
    moduleDirectory;
    engines = new Map();
    feeds = new Map();
    constructor(moduleDirectory) {
        this.moduleDirectory = moduleDirectory;
    }
    get(root) {
        const resolved = path.resolve(root);
        const existing = this.engines.get(resolved);
        if (existing !== undefined)
            return existing;
        const started = this.start(resolved);
        this.engines.set(resolved, started);
        return started;
    }
    /**
     * Retire every cached engine because something may have written to disk.
     * Called from `tools/pre-execute`, before the mutating tool runs, so a search
     * can never observe a workspace caught mid-write. The next search rebuilds.
     */
    invalidate(reason) {
        for (const feed of this.feeds.values())
            feed.mark(reason);
        this.closeAll();
    }
    async start(root) {
        let engine;
        try {
            const addonPath = await resolvePackagedKernelAddonPath(this.moduleDirectory);
            // The trusted feed is what makes repeat queries cheap: without it the
            // engine re-verifies every file's contents around each search, which
            // costs more than the ripgrep scan it replaces. The contract is that
            // `invalidate` runs before any tool that can write.
            const feed = new KernelMutationFeed();
            this.feeds.set(root, feed);
            engine = new OptInKernelEngine({
                root,
                addonPath,
                indexPath: indexPathFor(root),
                trustedMutationFeed: feed,
            });
            await engine.start();
            return engine;
        }
        catch {
            engine?.close();
            return undefined;
        }
    }
    closeAll() {
        for (const pending of this.engines.values()) {
            void pending.then((engine) => engine?.close()).catch(() => {
                // An engine that never started has nothing to release.
            });
        }
        this.engines.clear();
        this.feeds.clear();
    }
}
/**
 * Register the indexed `grep` tool.
 *
 * @param ctx - plugin context; the registration is scoped to this plugin.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
    const maxMatches = config.maxMatches ?? DEFAULT_MAX_MATCHES;
    if (!Number.isInteger(maxMatches) || maxMatches <= 0) {
        throw new Error("snapgrep: maxMatches must be a positive integer");
    }
    const cache = new EngineCache(import.meta.dirname);
    const tool = defineTool({
        name: "grep",
        description: "Search file contents with a ripgrep regular expression. Returns matching "
            + `lines with line numbers, grouped by file, up to ${maxMatches} matches. `
            + "Answered from an in-process index; results are identical to ripgrep.",
        parameters: {
            pattern: {
                type: "string",
                required: true,
                description: "Regular expression to search for (ripgrep syntax).",
            },
            path: {
                type: "string",
                description: "File or directory to search. Defaults to the session workspace; a "
                    + "relative path resolves against it.",
            },
            include: {
                type: "string",
                description: "One glob filter for which files to search (e.g. \"*.ts\"). Not a "
                    + "list; negation is not supported.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    matches: {
                        type: "array",
                        required: true,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                path: { type: "string", required: true },
                                lineNumber: { type: "integer", required: true },
                                line: { type: "string", required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [
                { type: "text", text: formatMatches(value.matches) },
            ],
        },
        async execute(args, exec) {
            const workdir = exec.agent?.session?.header?.cwd ?? process.cwd();
            const engine = await cache.get(workdir);
            const request = {
                pattern: args.pattern,
                hidden: false,
                context: 0,
                limit: maxMatches,
                ...(args.path === undefined ? {} : { path: args.path }),
                ...(args.include === undefined ? {} : { glob: args.include }),
            };
            const result = engine === undefined
                ? await runRipgrep(workdir, request, { signal: exec.signal })
                : await engine.search(request, exec.signal);
            return {
                matches: result.matches.map((match) => ({
                    path: match.path,
                    lineNumber: match.lineNumber,
                    line: match.lineText,
                })),
            };
        },
    });
    ctx.tools.register(tool);
    // Retire the index before anything that can write runs, never after: a
    // post-execute hook is too late to order a concurrent search against a
    // mutator. This mirrors the contract the Pi extension operates under.
    ctx.on?.("tools/pre-execute", async (exec, next) => {
        const toolName = exec?.toolName;
        if (typeof toolName === "string" && mayMutate(toolName)) {
            cache.invalidate(`dsh_tool_execution:${toolName}`);
        }
        return next();
    });
    ctx.on?.("dispose", () => cache.closeAll());
}
