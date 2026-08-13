/**
 * A DeepSeek Harness plugin that answers the `grep` tool from the indexed
 * kernel instead of spawning ripgrep.
 *
 * The harness ships `@deepseek-ai/dsh-tool-fs-search`, which spawns the
 * packaged ripgrep binary through `ctx.subprocess.spawn()` for every call. That
 * pays a process launch plus a full scan each time. This plugin registers a
 * tool that answers from the index instead, keeping the exact output shape the
 * harness expects: `{ matches: [{ path, lineNumber, line }] }`.
 *
 * The tool registry rejects a duplicate name outright, so the bundle patch
 * disables the built-in row rather than shadowing it. That takes `glob` down
 * with it, so this plugin supplies an equivalent one alongside `grep`.
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
import { resolvePackagedKernelAddonPath } from "./addon-path.js";
import { KernelMutationFeed, OptInKernelEngine } from "./kernel-engine.js";
import { runCommand } from "./process.js";
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
/** Matches the built-in glob tool's inline cap. */
const DEFAULT_MAX_PATHS = 100;
/** Version-control metadata the built-in glob tool keeps out of results. */
const VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
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
 * Register the indexed `grep` tool and its companion `glob`.
 *
 * @param ctx - plugin context; the registration is scoped to this plugin.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
    const maxMatches = config.maxMatches ?? DEFAULT_MAX_MATCHES;
    const maxPaths = config.maxPaths ?? DEFAULT_MAX_PATHS;
    if (!Number.isInteger(maxMatches) || maxMatches <= 0) {
        throw new Error("snapgrep: maxMatches must be a positive integer");
    }
    if (!Number.isInteger(maxPaths) || maxPaths <= 0) {
        throw new Error("snapgrep: maxPaths must be a positive integer");
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
    // Disabling the built-in search suite to claim `grep` takes `glob` with it,
    // so supply an equivalent. File discovery has nothing to gain from the
    // content index, so this runs the same ripgrep invocation the built-in used:
    // same flags, same modification-time ordering, same VCS exclusions.
    const globTool = defineTool({
        name: "glob",
        description: "Find files by path pattern. A pattern with no \"/\" matches basenames at "
            + `any depth. Returns files only, in modification-time order, up to ${maxPaths} paths. `
            + "Includes hidden and ignored files.",
        parameters: {
            pattern: {
                type: "string",
                required: true,
                description: "Glob pattern to match against paths (e.g. \"*.ts\", \"src/**/*.tsx\").",
            },
            path: {
                type: "string",
                description: "Directory to search. Defaults to the session workspace.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    paths: { type: "array", required: true, items: { type: "string" } },
                },
            },
            render: (_args, value) => [
                {
                    type: "text",
                    text: value.paths.length === 0
                        ? "No files matched."
                        : [`Found ${value.paths.length} file${value.paths.length === 1 ? "" : "s"}:`, "", ...value.paths].join("\n"),
                },
            ],
        },
        async execute(args, exec) {
            const workdir = exec.agent?.session?.header?.cwd ?? process.cwd();
            const argv = [
                "--files",
                `--glob=${args.pattern}`,
                "--sort=modified",
                "--no-ignore",
                "--hidden",
                ...VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
            ];
            if (args.path !== undefined)
                argv.push("--", args.path);
            const result = await runCommand("rg", argv, {
                cwd: workdir,
                allowExitCodes: [0, 1],
                ...(exec.signal === undefined ? {} : { signal: exec.signal }),
            });
            const paths = result.stdout.split("\n").filter((line) => line.length > 0);
            return { paths: paths.slice(0, maxPaths) };
        },
    });
    ctx.tools.register(tool);
    ctx.tools.register(globTool);
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
