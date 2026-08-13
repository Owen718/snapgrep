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
    const filename = `pi-fast-grep-kernel.${platform}-${architecture}.node`;
    const candidates = [
        path.resolve(moduleDirectory, "../native", filename),
        path.resolve(moduleDirectory, "../native/kernel/binding", filename),
        path.resolve(moduleDirectory, "../../native/kernel/binding", filename),
    ];
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
