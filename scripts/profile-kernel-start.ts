import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadKernelBinding,
  type NativeKernelBinding,
} from "../src/kernel-binding.ts";
import {
  KernelMutationFeed,
  OptInKernelEngine,
} from "../src/kernel-engine.ts";
import { runCommand } from "../src/process.ts";

interface StartProbe {
  captureSource(
    signal?: AbortSignal,
    binding?: NativeKernelBinding,
  ): Promise<unknown>;
  listUniverse(signal?: AbortSignal): Promise<string[]>;
  cleanSnapshot(
    universe: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown>;
  readManifest(): Promise<unknown>;
}

interface StartSample {
  totalMs: number;
  captureMs: number;
  listUniverseMs: number;
  cleanSnapshotMs: number;
  contentResidualMs: number;
  readManifestMs: number;
  reusedPersistentGeneration: boolean;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

function summary(values: readonly number[]) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function writeFixture(
  root: string,
  fileCount: number,
  bytesPerFile: number,
): Promise<string[]> {
  await writeFile(path.join(root, ".gitignore"), ".pi/index/\n");
  const relativePaths = [".gitignore"];
  const directories = Math.max(1, Math.ceil(fileCount / 100));
  for (let directory = 0; directory < directories; directory += 1) {
    await mkdir(
      path.join(root, "src", `d${String(directory).padStart(3, "0")}`),
      { recursive: true },
    );
  }
  const filler = "abcdefghijklmnopqrstuvwxyz0123456789";
  const writes: Promise<void>[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const directory = Math.floor(index / 100);
    const prefix =
      index === Math.floor(fileCount / 2)
        ? `export const rare = "pi_fast_grep_rare_literal";\n`
        : `export const value${index} = ${index};\n`;
    const repeated = filler.repeat(
      Math.max(1, Math.ceil((bytesPerFile - prefix.length) / filler.length)),
    );
    const content = `${prefix}${repeated}`.slice(0, bytesPerFile);
    const relativePath = path.join(
      "src",
      `d${String(directory).padStart(3, "0")}`,
      `file-${String(index).padStart(5, "0")}.ts`,
    );
    relativePaths.push(relativePath);
    writes.push(writeFile(path.join(root, relativePath), content));
    if (writes.length === 64) {
      await Promise.all(writes.splice(0));
    }
  }
  await Promise.all(writes);
  return relativePaths.sort();
}

async function measuredStart(
  root: string,
  addonPath: string,
  sourceDigest: "native" | "js",
): Promise<{ sample: StartSample; indexPath: string }> {
  const engine = new OptInKernelEngine({
    root,
    addonPath,
    trustedMutationFeed: new KernelMutationFeed(),
  });
  const probe = engine as unknown as StartProbe;
  let captureMs = 0;
  let listUniverseMs = 0;
  let cleanSnapshotMs = 0;
  let readManifestMs = 0;

  const captureSource = probe.captureSource.bind(engine);
  probe.captureSource = async (
    signal?: AbortSignal,
    binding?: NativeKernelBinding,
  ) => {
    const started = performance.now();
    try {
      return await captureSource(signal, binding);
    } finally {
      captureMs += performance.now() - started;
    }
  };
  const listUniverse = probe.listUniverse.bind(engine);
  probe.listUniverse = async (signal?: AbortSignal) => {
    const started = performance.now();
    try {
      return await listUniverse(signal);
    } finally {
      listUniverseMs += performance.now() - started;
    }
  };
  const cleanSnapshot = probe.cleanSnapshot.bind(engine);
  probe.cleanSnapshot = async (
    universe: readonly string[],
    signal?: AbortSignal,
  ) => {
    const started = performance.now();
    try {
      return await cleanSnapshot(universe, signal);
    } finally {
      cleanSnapshotMs += performance.now() - started;
    }
  };
  const readManifest = probe.readManifest.bind(engine);
  probe.readManifest = async () => {
    const started = performance.now();
    try {
      return await readManifest();
    } finally {
      readManifestMs += performance.now() - started;
    }
  };

  const started = performance.now();
  const signal =
    sourceDigest === "native" ? undefined : new AbortController().signal;
  const result = await engine.start(signal);
  const totalMs = performance.now() - started;
  const indexPath = engine.indexPath;
  engine.close();
  return {
    indexPath,
    sample: {
      totalMs,
      captureMs,
      listUniverseMs,
      cleanSnapshotMs,
      contentResidualMs: Math.max(
        0,
        captureMs - listUniverseMs - cleanSnapshotMs,
      ),
      readManifestMs,
      reusedPersistentGeneration: result.reusedPersistentGeneration,
    },
  };
}

async function main(): Promise<void> {
  const fileCount = Number.parseInt(process.argv[2] ?? "2001", 10);
  const bytesPerFile = Number.parseInt(process.argv[3] ?? "1024", 10);
  const samples = Number.parseInt(process.argv[4] ?? "11", 10);
  const sourceDigest =
    process.env.PI_FAST_GREP_PROFILE_SOURCE_DIGEST === "js"
      ? "js"
      : "native";
  if (
    !Number.isSafeInteger(fileCount)
    || fileCount < 1
    || !Number.isSafeInteger(bytesPerFile)
    || bytesPerFile < 64
    || !Number.isSafeInteger(samples)
    || samples < 3
  ) {
    throw new Error("usage: profile-kernel-start [files>=1] [bytes>=64] [samples>=3]");
  }

  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const bindingDirectory = path.join(
    workspaceRoot,
    "native",
    "kernel",
    "binding",
  );
  const addons = (await readdir(bindingDirectory)).filter((entry) =>
    entry.endsWith(".node")
  );
  if (addons.length !== 1) {
    throw new Error(`expected exactly one native addon, found ${addons.length}`);
  }
  const addonPath = path.join(bindingDirectory, addons[0] as string);
  const fixture = await mkdtemp(path.join(tmpdir(), "pi-fast-grep-start-profile-"));

  try {
    const fixturePaths = await writeFixture(fixture, fileCount, bytesPerFile);
    await runCommand("git", ["init", "-q"], { cwd: fixture });
    await runCommand("git", ["config", "user.email", "kernel@example.invalid"], {
      cwd: fixture,
    });
    await runCommand("git", ["config", "user.name", "Kernel Profile"], {
      cwd: fixture,
    });
    await runCommand("git", ["add", "."], { cwd: fixture });
    await runCommand("git", ["commit", "-qm", "fixture"], { cwd: fixture });
    if (process.env.PI_FAST_GREP_PROFILE_GC === "1") {
      (globalThis as { gc?: () => void }).gc?.();
    }

    if (process.env.PI_FAST_GREP_PROFILE_DIRECT_ONLY === "1") {
      const binding = loadKernelBinding(addonPath);
      const canonicalRoot = await realpath(fixture);
      const directTimes: number[] = [];
      for (let index = 0; index < samples; index += 1) {
        const digest = binding.hashSourceContents(
          fixture,
          canonicalRoot,
          fixturePaths,
        );
        directTimes.push(Number(digest.durationNs) / 1_000_000);
      }
      process.stdout.write(
        `${JSON.stringify({
          sourceDigest,
          fixture: {
            files: fixturePaths.length,
            bytesPerFile,
            sourceBytesApprox: fileCount * bytesPerFile,
          },
          directSourceDigestMs: summary(directTimes),
        }, null, 2)}\n`,
      );
      return;
    }

    const cold = await measuredStart(fixture, addonPath, sourceDigest);
    const binding = loadKernelBinding(addonPath);
    let directSourceDigestMs:
      | ReturnType<typeof summary>
      | undefined;
    if (process.env.PI_FAST_GREP_PROFILE_DIRECT_DIGEST === "1") {
      const probeEngine = new OptInKernelEngine({
        root: fixture,
        addonPath,
        trustedMutationFeed: new KernelMutationFeed(),
      });
      const paths = await (
        probeEngine as unknown as StartProbe
      ).listUniverse();
      probeEngine.close();
      const canonicalRoot = await realpath(fixture);
      const directTimes: number[] = [];
      for (let index = 0; index < samples; index += 1) {
        const digest = binding.hashSourceContents(
          fixture,
          canonicalRoot,
          paths,
        );
        directTimes.push(Number(digest.durationNs) / 1_000_000);
      }
      directSourceDigestMs = summary(directTimes);
    }
    const openTimes: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      const opened = binding.KernelIndex.open(cold.indexPath);
      openTimes.push(performance.now() - started);
      opened.close();
    }
    const indexHashTimes: number[] = [];
    const addonHashTimes: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      let started = performance.now();
      await hashFile(cold.indexPath);
      indexHashTimes.push(performance.now() - started);
      started = performance.now();
      await hashFile(addonPath);
      addonHashTimes.push(performance.now() - started);
    }

    const warm: StartSample[] = [];
    for (let index = 0; index < samples; index += 1) {
      const measured = await measuredStart(fixture, addonPath, sourceDigest);
      if (!measured.sample.reusedPersistentGeneration) {
        throw new Error("warm sample unexpectedly rebuilt the generation");
      }
      warm.push(measured.sample);
    }
    const metric = (key: keyof StartSample) =>
      summary(warm.map((sample) => Number(sample[key])));
    process.stdout.write(
      `${JSON.stringify({
        sourceDigest,
        fixture: {
          files: fileCount + 1,
          bytesPerFile,
          sourceBytesApprox: fileCount * bytesPerFile,
        },
        coldBuild: cold.sample,
        warmOpen: {
          samples,
          totalMs: metric("totalMs"),
          captureMs: metric("captureMs"),
          listUniverseMs: metric("listUniverseMs"),
          cleanSnapshotMs: metric("cleanSnapshotMs"),
          contentResidualMs: metric("contentResidualMs"),
          readManifestMs: metric("readManifestMs"),
        },
        independent: {
          directSourceDigestMs,
          nativeOpenMs: summary(openTimes),
          indexSha256Ms: summary(indexHashTimes),
          addonSha256Ms: summary(addonHashTimes),
        },
      }, null, 2)}\n`,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

await main();
