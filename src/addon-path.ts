/**
 * Locating the packaged native addon.
 *
 * This lives apart from the Pi extension on purpose: the DeepSeek Harness
 * plugin needs the same lookup, and importing it from `extension.ts` would drag
 * `@earendil-works/pi-coding-agent` into a process that has no reason to have
 * it installed.
 */

import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Find the addon built for this platform inside the packaged extension.
 *
 * @param moduleDirectory - directory of the calling module.
 * @param platform - Node platform identifier.
 * @param architecture - Node architecture identifier.
 * @returns absolute path to the matching `.node` file.
 * @throws When no addon exists for this platform, naming every path tried so a
 *   missing build target is obvious rather than silent.
 */
export async function resolvePackagedKernelAddonPath(
  moduleDirectory = import.meta.dirname,
  platform: string = process.platform,
  architecture: string = process.arch,
): Promise<string> {
  const targets = addonTargets(platform, architecture);

  // Installed from npm, the addon arrives as an optional dependency that npm
  // only unpacks when its `os`/`cpu` match, so resolution — not a path guess —
  // is what finds it. Downloaded as a release archive it sits beside this
  // module instead. Both layouts are supported, and the resolver runs first
  // because an npm install is the more specific answer.
  for (const target of targets) {
    const resolved = resolveFromNodeModules(`snapgrep-${target}`, moduleDirectory);
    if (resolved !== undefined) return resolved;
  }

  const candidates: string[] = [];
  for (const target of targets) {
    const filename = `pi-fast-grep-kernel.${target}.node`;
    candidates.push(
      path.resolve(moduleDirectory, "../native", filename),
      path.resolve(moduleDirectory, "../native/kernel/binding", filename),
      path.resolve(moduleDirectory, "../../native/kernel/binding", filename),
    );
  }
  for (const addonPath of candidates) {
    try {
      const addonStat = await stat(addonPath);
      if (addonStat.isFile()) return addonPath;
    } catch {
      // Try the source/npm package layout after the standalone artifact layout.
    }
  }
  throw new Error(
    `packaged kernel addon is missing for ${platform}-${architecture}; `
    + `no installed snapgrep-${targets[0]} package, and none of: ${candidates.join(", ")}`,
  );
}

/**
 * Locate a per-platform addon package through Node's resolver.
 *
 * Returns `undefined` when the package is absent, which is the normal case for
 * every platform except the host's: npm skips optional dependencies whose
 * `os`/`cpu` do not match, so four of the five are expected to be missing.
 */
function resolveFromNodeModules(
  packageName: string,
  moduleDirectory: string,
): string | undefined {
  try {
    const require = createRequire(path.join(moduleDirectory, "resolver.cjs"));
    return require.resolve(packageName);
  } catch {
    return undefined;
  }
}

/**
 * Addon basenames to try, most specific first.
 *
 * On Linux, napi names the output after the full Rust target triple, so a
 * glibc build lands as `linux-x64-gnu` and a musl one as `linux-x64-musl`.
 * Those binaries are not interchangeable, so the suffix is kept rather than
 * renamed away; the bare `linux-x64` form stays in the list for artifacts built
 * before this distinction was handled.
 */
function addonTargets(platform: string, architecture: string): string[] {
  const base = `${platform}-${architecture}`;
  if (platform !== "linux") return [base];
  return [`${base}-gnu`, `${base}-musl`, base];
}
