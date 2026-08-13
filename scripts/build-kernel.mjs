import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const crateRoot = path.join(workspaceRoot, "native", "kernel");
const outputDirectory = path.join(crateRoot, "binding");
const executable = path.join(
  workspaceRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "napi.cmd" : "napi",
);

mkdirSync(outputDirectory, { recursive: true });
const result = spawnSync(
  executable,
  [
    "build",
    "--release",
    "--manifest-path",
    "Cargo.toml",
    "--package-json-path",
    "../../package.json",
    "--target-dir",
    "target",
    "--output-dir",
    "binding",
    "--platform",
    "--js",
    "index.cjs",
    "--dts",
    "index.d.ts",
  ],
  {
    cwd: crateRoot,
    env: process.env,
    stdio: "inherit",
    // Node refuses to spawn .cmd/.bat directly on Windows since the CVE-2024-27980
    // fix, so the napi shim needs a shell there. Every argument below is a fixed
    // literal without spaces, so shell quoting cannot change what runs.
    shell: process.platform === "win32",
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
