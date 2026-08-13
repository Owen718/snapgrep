import { execFile } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "../.deps/pi/packages/coding-agent/dist/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(repoRoot, ".bench", "k17-extension-smoke");
const fixtureRoot = path.join(runRoot, "repo");
const agentDir = path.join(runRoot, "agent");
const artifactRoot = path.join(repoRoot, "artifacts", "pi-extension", "pi-fast-grep");
const installedRoot = path.join(fixtureRoot, ".pi", "extensions", "pi-fast-grep");
const piCli = path.join(repoRoot, ".deps", "pi", "packages", "coding-agent", "dist", "cli.js");
const outputPath = path.join(repoRoot, "artifacts", "results", "K17_SESSION_RECOVERY_SMOKE_20260813.json");
const rssLimitBytes = 3 * 1024 * 1024 * 1024;
const startedAt = performance.now();
let peakTreeRssBytes = 0;
let watchdogError;

async function sampleTreeRss() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], { timeout: 2_000 });
  const rows = stdout.trim().split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/u).map(Number);
    return fields.length === 3 && fields.every(Number.isFinite)
      ? [{ pid: fields[0], ppid: fields[1], rssBytes: fields[2] * 1024 }]
      : [];
  });
  const selected = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  const rssBytes = rows
    .filter((row) => selected.has(row.pid))
    .reduce((sum, row) => sum + row.rssBytes, 0);
  peakTreeRssBytes = Math.max(peakTreeRssBytes, rssBytes);
  if (rssBytes > rssLimitBytes) watchdogError = new Error(`RSS limit exceeded: ${rssBytes}`);
}

const watchdog = setInterval(() => {
  void sampleTreeRss().catch((error) => {
    watchdogError = error instanceof Error ? error : new Error(String(error));
  });
}, 100);

function assertHealthy() {
  if (watchdogError) throw watchdogError;
  if (performance.now() - startedAt > 60_000) throw new Error("extension smoke exceeded 60 seconds");
}

async function runGit(args) {
  await execFileAsync("git", args, {
    cwd: fixtureRoot,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-fast-grep smoke",
      GIT_AUTHOR_EMAIL: "smoke@example.invalid",
      GIT_COMMITTER_NAME: "pi-fast-grep smoke",
      GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    },
  });
}

function metadata(result) {
  const value = result?.details?.metadata;
  if (typeof value !== "object" || value === null) throw new Error("grep result omitted metadata");
  return value;
}

let session;
try {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  for (let index = 0; index < 300; index += 1) {
    const marker = index === 17 ? " SESSION_RECOVERY_MARKER initial" : "";
    await writeFile(path.join(fixtureRoot, "src", `file-${String(index).padStart(3, "0")}.txt`), `ordinary-${index}${marker}\n`);
  }
  await runGit(["init", "-q"]);
  await runGit(["add", "."]);
  await runGit(["commit", "-qm", "fixture"]);

  const installStartedAt = performance.now();
  await mkdir(path.dirname(installedRoot), { recursive: true });
  await cp(artifactRoot, installedRoot, { recursive: true });
  const installMs = performance.now() - installStartedAt;
  assertHealthy();

  const helpStartedAt = performance.now();
  const { stdout: helpOutput, stderr: helpError } = await execFileAsync(
    process.execPath,
    [piCli, "--approve", "--offline", "--help"],
    {
      cwd: fixtureRoot,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    },
  );
  const loaderProbeMs = performance.now() - helpStartedAt;
  if (!`${helpOutput}\n${helpError}`.includes("packaged kernel")) {
    throw new Error("fixed Pi CLI did not load the installed extension");
  }
  assertHealthy();

  const piStartedAt = performance.now();
  const settingsManager = SettingsManager.create(fixtureRoot, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({ cwd: fixtureRoot, agentDir, settingsManager });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: fixtureRoot,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(fixtureRoot),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
  session = created.session;
  const piStartMs = performance.now() - piStartedAt;
  const grepInfo = session.getAllTools().find((tool) => tool.name === "grep");
  if (!grepInfo?.sourceInfo.path.includes(".pi/extensions/pi-fast-grep/src/packaged-extension.js")) {
    throw new Error(`grep was not replaced by installed extension: ${grepInfo?.sourceInfo.path}`);
  }
  const grep = session.getToolDefinition("grep");
  if (!grep) throw new Error("installed extension did not register grep");
  const edit = session.getToolDefinition("edit");
  const bash = session.getToolDefinition("bash");
  if (!edit || !bash) throw new Error("fixed Pi did not expose edit and bash tools");
  const context = session.extensionRunner.createCommandContext();
  const { runRipgrep } = await import(pathToFileURL(
    path.join(installedRoot, "src", "rg.js"),
  ).href);
  const request = {
    pattern: "SESSION_RECOVERY_MARKER",
    literal: true,
    context: 0,
    limit: 20,
  };

  const executeMutator = async (toolCallId, toolName, definition, input) => {
    await session.extensionRunner.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args: input,
    });
    const result = await definition.execute(
      toolCallId,
      input,
      undefined,
      undefined,
      context,
    );
    const completedAt = performance.now();
    await session.extensionRunner.emitToolResult({
      type: "tool_result",
      toolCallId,
      toolName,
      input,
      content: result.content,
      details: result.details,
      isError: false,
    });
    return completedAt;
  };

  const executeAndCompareSearch = async (toolCallId) => {
    const result = await grep.execute(
      toolCallId,
      request,
      undefined,
      undefined,
      context,
    );
    const normal = await runRipgrep(fixtureRoot, { ...request, hidden: true });
    if (JSON.stringify(result.details.matches) !== JSON.stringify(normal.matches)) {
      throw new Error(`${toolCallId} did not equal same-time rg`);
    }
    return result;
  };

  const firstQueryStartedAt = performance.now();
  const first = await executeAndCompareSearch("k17-first");
  const firstQueryMs = performance.now() - firstQueryStartedAt;
  const processStartToFirstResultMs = performance.now() - startedAt;
  const firstMetadata = metadata(first);
  if (firstMetadata.actualBackend !== "kernel" || !first.content[0]?.text.includes("SESSION_RECOVERY_MARKER")) {
    throw new Error(`first search failed: ${JSON.stringify(firstMetadata)}`);
  }
  assertHealthy();

  const firstEditCompletedAt = await executeMutator(
    "k17-edit-one",
    "edit",
    edit,
    {
      path: "src/file-017.txt",
      edits: [{
        oldText: "SESSION_RECOVERY_MARKER initial",
        newText: "SESSION_RECOVERY_MARKER initial\nSESSION_RECOVERY_MARKER edit-one",
      }],
    },
  );
  const afterFirstEdit = await executeAndCompareSearch("k17-after-edit-one");
  const firstRecoveryMs = performance.now() - firstEditCompletedAt;
  const firstRecoveryMetadata = metadata(afterFirstEdit);
  if (firstRecoveryMetadata.actualBackend !== "kernel" || firstRecoveryMetadata.totalMatches !== 2) {
    throw new Error(`first recovery failed: ${JSON.stringify(firstRecoveryMetadata)}`);
  }

  const secondEditCompletedAt = await executeMutator(
    "k17-edit-two",
    "edit",
    edit,
    {
      path: "src/file-042.txt",
      edits: [{
        oldText: "ordinary-42",
        newText: "ordinary-42 SESSION_RECOVERY_MARKER edit-two",
      }],
    },
  );
  const afterSecondEdit = await executeAndCompareSearch("k17-after-edit-two");
  const secondRecoveryMs = performance.now() - secondEditCompletedAt;
  const secondRecoveryMetadata = metadata(afterSecondEdit);
  if (secondRecoveryMetadata.actualBackend !== "kernel" || secondRecoveryMetadata.totalMatches !== 3) {
    throw new Error(`second recovery failed: ${JSON.stringify(secondRecoveryMetadata)}`);
  }

  const bashCompletedAt = await executeMutator(
    "k17-bash",
    "bash",
    bash,
    { command: "printf 'SESSION_RECOVERY_MARKER bash\\n' >> src/file-043.txt" },
  );
  const afterBash = await executeAndCompareSearch("k17-after-bash");
  const bashRecoveryMs = performance.now() - bashCompletedAt;
  const bashRecoveryMetadata = metadata(afterBash);
  if (bashRecoveryMetadata.actualBackend !== "kernel" || bashRecoveryMetadata.totalMatches !== 4) {
    throw new Error(`bash recovery failed: ${JSON.stringify(bashRecoveryMetadata)}`);
  }
  assertHealthy();

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  session = undefined;
  await sampleTreeRss();

  const artifact = {
    schemaVersion: "pi-fast-grep-session-recovery-smoke/v1",
    passed: true,
    fixtureFiles: 300,
    installedExtension: path.relative(repoRoot, installedRoot),
    grepSource: path.relative(repoRoot, grepInfo.sourceInfo.path),
    timingsMs: {
      install: installMs,
      loaderProbe: loaderProbeMs,
      piStartAndIndex: piStartMs,
      firstSearch: firstQueryMs,
      processStartToFirstResult: processStartToFirstResultMs,
      firstEditToKernelResult: firstRecoveryMs,
      secondEditToKernelResult: secondRecoveryMs,
      bashToKernelResult: bashRecoveryMs,
      total: performance.now() - startedAt,
    },
    firstSearch: {
      actualBackend: firstMetadata.actualBackend,
      totalMatches: firstMetadata.totalMatches,
    },
    afterFirstEdit: {
      actualBackend: firstRecoveryMetadata.actualBackend,
      totalMatches: firstRecoveryMetadata.totalMatches,
    },
    afterSecondEdit: {
      actualBackend: secondRecoveryMetadata.actualBackend,
      totalMatches: secondRecoveryMetadata.totalMatches,
    },
    afterBash: {
      actualBackend: bashRecoveryMetadata.actualBackend,
      totalMatches: bashRecoveryMetadata.totalMatches,
    },
    resources: {
      peakTreeRssBytes,
      treeRssLimitBytes: rssLimitBytes,
      nodeOldSpaceMiB: 2048,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  process.stdout.write(`${JSON.stringify(artifact, undefined, 2)}\n`);
} finally {
  clearInterval(watchdog);
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await rm(runRoot, { recursive: true, force: true });
}
