/**
 * Locating the packaged native addon.
 *
 * This lives apart from the Pi extension on purpose: the DeepSeek Harness
 * plugin needs the same lookup, and importing it from `extension.ts` would drag
 * `@earendil-works/pi-coding-agent` into a process that has no reason to have
 * it installed.
 */
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
export async function resolvePackagedKernelAddonPath(moduleDirectory = import.meta.dirname, platform = process.platform, architecture = process.arch) {
    const candidates = [];
    for (const target of addonTargets(platform, architecture)) {
        const filename = `pi-fast-grep-kernel.${target}.node`;
        candidates.push(path.resolve(moduleDirectory, "../native", filename), path.resolve(moduleDirectory, "../native/kernel/binding", filename), path.resolve(moduleDirectory, "../../native/kernel/binding", filename));
    }
    for (const addonPath of candidates) {
        try {
            const addonStat = await stat(addonPath);
            if (addonStat.isFile())
                return addonPath;
        }
        catch {
            // Try the source/npm package layout after the standalone artifact layout.
        }
    }
    throw new Error(`packaged kernel addon is missing for ${platform}-${architecture}; checked ${candidates.join(", ")}`);
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
function addonTargets(platform, architecture) {
    const base = `${platform}-${architecture}`;
    if (platform !== "linux")
        return [base];
    return [`${base}-gnu`, `${base}-musl`, base];
}
