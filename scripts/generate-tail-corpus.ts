#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/process.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, ".bench", "repos", "Tail-synthetic");
const FILE_TARGET = 5_000;
const BYTE_LIMIT = 20 * 1024 * 1024;
const SEED = 0x5eedc0de;
const HOT_FILES = 4_000;
const YAML_FILES = 800;
const FILLER_FILES = 189;
const BINARY_FILES = 4;
const EMPTY_FILES = 3;
const LONG_LINE_FILES = 2;
const HOT_TOKEN = "TAIL_HOT_TOKEN";
const YAML_TOKEN = "TAIL_YAML_TOKEN";

class DeterministicRandom {
  constructor(private state: number) {}

  next(): number {
    let value = this.state >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
}

function deterministicText(prefix: string, bytes: number, random: DeterministicRandom, eol = "\n"): string {
  const lines: string[] = [prefix];
  while (Buffer.byteLength(lines.join(eol)) + eol.length < bytes) {
    const value = random.next().toString(16).padStart(8, "0");
    lines.push(`const filler_${value} = "bounded deterministic benchmark payload ${value}";`);
  }
  let output = `${lines.join(eol)}${eol}`;
  while (Buffer.byteLength(output) < bytes) output += `x`;
  return Buffer.from(output, "utf8").subarray(0, bytes).toString("utf8");
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  await visit(root);
  return files;
}

async function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await runCommand("git", args, { cwd: root, ...(env === undefined ? {} : { env }) })).stdout.trim();
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf("--output");
  const output = outputFlag >= 0
    ? path.resolve(process.cwd(), process.argv[outputFlag + 1] ?? "")
    : DEFAULT_OUTPUT;
  if (output.length === 0) throw new Error("--output requires a path");
  const expected = path.resolve(DEFAULT_OUTPUT);
  if (path.resolve(output) !== expected) {
    throw new Error(`Refusing to generate outside the fixed safe Tail corpus path: ${output}`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const random = new DeterministicRandom(SEED);
  let crlfFiles = 0;
  for (let index = 0; index < HOT_FILES; index += 1) {
    const group = String(index % 40).padStart(2, "0");
    const nested = String(Math.floor(index / 40) % 10).padStart(2, "0");
    const relative = path.join("src", `group-${group}`, `nested-${nested}`, `hot-${String(index).padStart(4, "0")}.txt`);
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    const eol = index < 3 ? "\r\n" : "\n";
    if (index < 3) crlfFiles += 1;
    const prefix = [
      `${HOT_TOKEN} file_${index}`,
      ...(index < 1_200 ? [`TAIL_ESCAPED_TOKEN(`] : []),
      ...(index % 8 === 0 ? ["TAIL_CASE_TOKEN"] : []),
      ...(index === 3_999 ? ["TAIL_RARE_TOKEN"] : []),
    ].join(eol);
    await writeFile(path.join(output, relative), deterministicText(prefix, 3_900, random, eol));
  }
  for (let index = 0; index < YAML_FILES; index += 1) {
    const relative = path.join("configs", `zone-${String(index % 20).padStart(2, "0")}`, `manifest-${String(index).padStart(4, "0")}.yaml`);
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    const prefix = `apiVersion: benchmark/v1\nkind: TailKind\nname: item-${index}\ntoken: ${YAML_TOKEN}\n`;
    await writeFile(path.join(output, relative), deterministicText(prefix, 1_000, random));
  }
  for (let index = 0; index < FILLER_FILES; index += 1) {
    const relative = path.join("docs", `section-${String(index % 12).padStart(2, "0")}`, `filler-${String(index).padStart(3, "0")}.md`);
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    await writeFile(path.join(output, relative), deterministicText(`# bounded filler ${index}`, 2_500, random));
  }
  for (let index = 0; index < BINARY_FILES; index += 1) {
    const relative = path.join("assets", `binary-${index}.bin`);
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    const bytes = Buffer.alloc(4_096, index + 1);
    bytes[0] = 0;
    Buffer.from(index % 2 === 0 ? HOT_TOKEN : YAML_TOKEN).copy(bytes, 128);
    await writeFile(path.join(output, relative), bytes);
  }
  for (let index = 0; index < EMPTY_FILES; index += 1) {
    const relative = path.join("empty", `empty-${index}.txt`);
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    await writeFile(path.join(output, relative), "");
  }
  for (let index = 0; index < LONG_LINE_FILES; index += 1) {
    const relative = path.join("long-lines", `long-${index}.txt`);
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    await writeFile(path.join(output, relative), `${"L".repeat(64 * 1024)} TAIL_LONG_LINE_TOKEN_${index}\n`);
  }
  await writeFile(path.join(output, "README.md"), "# Safe synthetic tail corpus\nTAIL_README_TOKEN\n");
  const marker = {
    kind: "Tail",
    safe: true,
    schemaVersion: 1,
    seed: SEED,
    requestedFiles: FILE_TARGET,
    hotFiles: HOT_FILES,
    yamlFiles: YAML_FILES,
    crlfFiles,
    hotToken: HOT_TOKEN,
    yamlToken: YAML_TOKEN,
  };
  await writeFile(path.join(output, ".benchmark-corpus.json"), `${JSON.stringify(marker, null, 2)}\n`);

  const files = await listFiles(output);
  const totalBytes = (await Promise.all(files.map(async (file) => (await stat(file)).size))).reduce((sum, value) => sum + value, 0);
  if (files.length !== FILE_TARGET) throw new Error(`Expected ${FILE_TARGET} files, generated ${files.length}`);
  if (totalBytes > BYTE_LIMIT) throw new Error(`Corpus ${totalBytes} bytes exceeds ${BYTE_LIMIT}`);
  if (crlfFiles < 2 || crlfFiles > 3) throw new Error(`Expected 2-3 CRLF files, generated ${crlfFiles}`);

  await git(output, ["init", "-q"]);
  await git(output, ["config", "user.name", "Fast Grep Benchmark"]);
  await git(output, ["config", "user.email", "benchmark@example.invalid"]);
  await git(output, ["add", "-f", "."]);
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  };
  await git(output, ["commit", "-qm", "deterministic synthetic tail corpus"], commitEnv);
  const commit = await git(output, ["rev-parse", "HEAD"]);
  const status = await git(output, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) throw new Error("Generated corpus is dirty after commit");
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const relative = path.relative(output, file).replaceAll(path.sep, "/");
    const bytes = await readFile(file);
    digest.update(`${Buffer.byteLength(relative)}:${relative}${bytes.byteLength}:`);
    digest.update(bytes);
  }
  process.stdout.write(`${JSON.stringify({ output, commit, files: files.length, totalBytes, crlfFiles, sha256: digest.digest("hex") }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
