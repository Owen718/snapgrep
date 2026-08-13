#!/usr/bin/env node

import { FastGrepEngine } from "./engine.js";
import { formatSearchResult } from "./format.js";
import type { SearchRequest } from "./types.js";

interface CliOptions {
  command: "search" | "index";
  root: string;
  backend: "auto" | "instant" | "normal";
  json: boolean;
  request: SearchRequest;
}

function usage(): string {
  return `Usage:
  npm run fast-grep -- search [options] PATTERN
  npm run fast-grep -- index [--root PATH]

Options:
  --root PATH          Repository root (default: cwd)
  --path PATH          Limit search to a file or subtree
  --glob GLOB          Apply a ripgrep glob
  -i, --ignore-case    Case-insensitive matching
  -F, --literal        Treat pattern as a fixed string
  -C, --context N      Context lines (default: 2)
  --limit N|all        Global result cap (default: 100)
  -U, --multiline      Enable ripgrep multiline mode (fallback)
  --hidden             Include hidden files (default)
  --no-hidden          Exclude hidden files
  --no-ignore          Include ignored files (fallback)
  --backend MODE       auto, instant, or normal
  --json               Emit structured JSON
`;
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return [value, index + 1];
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args[0];
  const command = first === "index" ? "index" : "search";
  if (first === "index" || first === "search") args.shift();
  let root = process.cwd();
  let backend: CliOptions["backend"] = "auto";
  let json = false;
  const request: SearchRequest = { pattern: "", context: 2, limit: 100, hidden: true };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--root" || arg === "--path" || arg === "--glob" || arg === "--backend" || arg === "--limit" || arg === "--context" || arg === "-C") {
      const [value, consumed] = takeValue(args, index, arg);
      index = consumed;
      if (arg === "--root") root = value;
      else if (arg === "--path") request.path = value;
      else if (arg === "--glob") request.glob = value;
      else if (arg === "--backend") {
        if (value !== "auto" && value !== "instant" && value !== "normal") throw new Error(`Invalid backend: ${value}`);
        backend = value;
      } else if (arg === "--limit") {
        request.limit = value === "all" ? null : Number(value);
      } else request.context = Number(value);
      continue;
    }
    if (arg === "-i" || arg === "--ignore-case") request.ignoreCase = true;
    else if (arg === "-F" || arg === "--literal") request.literal = true;
    else if (arg === "-U" || arg === "--multiline") request.multiline = true;
    else if (arg === "--hidden") request.hidden = true;
    else if (arg === "--no-hidden") request.hidden = false;
    else if (arg === "--no-ignore") request.noIgnore = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  if (command === "search") {
    if (positional.length !== 1) throw new Error("search requires exactly one PATTERN");
    request.pattern = positional[0] ?? "";
  }
  return { command, root, backend, json, request };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const engine = new FastGrepEngine({ root: options.root, requestedBackend: options.backend });
  try {
    await engine.start({ waitForIndex: true });
    if (options.command === "index") {
      process.stdout.write(`${JSON.stringify(engine.indexManager.status(), null, 2)}\n`);
      return;
    }
    const result = await engine.search(options.request, { backend: options.backend });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${formatSearchResult(result, options.request).text}\n`);
  } finally {
    await engine.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
