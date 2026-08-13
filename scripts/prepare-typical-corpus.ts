#!/usr/bin/env node

import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/process.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(PROJECT_ROOT, ".bench", "repos", "Typical-vite");
const SOURCE = "https://github.com/vitejs/vite.git";
const COMMIT = "d62b3360ecebdf11c23e99ffeb4b32e77c9a2ec8";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: TARGET })).stdout.trim();
}

async function main(): Promise<void> {
  const expected = path.resolve(PROJECT_ROOT, ".bench", "repos", "Typical-vite");
  if (path.resolve(TARGET) !== expected) throw new Error("Typical corpus target changed unexpectedly");
  if (await exists(TARGET)) {
    const actual = await git(["rev-parse", "HEAD"]).catch(() => "");
    const dirty = await git(["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "invalid");
    if (actual === COMMIT && dirty.length === 0) {
      process.stdout.write(`${JSON.stringify({ target: await realpath(TARGET), commit: actual, reused: true }, null, 2)}\n`);
      return;
    }
    throw new Error(`Refusing to replace existing Typical corpus at ${TARGET}; expected clean ${COMMIT}, found ${actual || "non-git"}`);
  }
  await mkdir(path.dirname(TARGET), { recursive: true });
  await mkdir(TARGET);
  try {
    await git(["init", "-q"]);
    await git(["remote", "add", "origin", SOURCE]);
    await git(["fetch", "--depth=1", "--filter=blob:none", "origin", COMMIT]);
    await git(["checkout", "-q", "--detach", "FETCH_HEAD"]);
    const actual = await git(["rev-parse", "HEAD"]);
    if (actual !== COMMIT) throw new Error(`Fetched ${actual}, expected ${COMMIT}`);
    const dirty = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty.length > 0) throw new Error("Prepared Typical corpus is dirty");
    process.stdout.write(`${JSON.stringify({ target: await realpath(TARGET), commit: actual, reused: false }, null, 2)}\n`);
  } catch (error) {
    await rm(TARGET, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
