import { createRequire } from "node:module";
import path from "node:path";
export const KERNEL_BINDING_ABI_VERSION = 10;
export class KernelBindingError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "KernelBindingError";
        this.code = code;
    }
}
const require = createRequire(import.meta.url);
function expectedRustTarget() {
    const operatingSystem = new Map([
        ["darwin", "macos"],
        ["freebsd", "freebsd"],
        ["linux", "linux"],
        ["win32", "windows"],
    ]).get(process.platform);
    const architecture = new Map([
        ["arm64", "aarch64"],
        ["ia32", "x86"],
        ["x64", "x86_64"],
    ]).get(process.arch);
    return `${operatingSystem ?? process.platform}-${architecture ?? process.arch}`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function loadKernelBinding(addonPath) {
    if (!path.isAbsolute(addonPath) || path.extname(addonPath) !== ".node") {
        throw new KernelBindingError("PFG_BINDING_PATH", `kernel addon path must be an absolute .node path: ${addonPath}`);
    }
    let raw;
    try {
        raw = require(addonPath);
    }
    catch (cause) {
        throw new KernelBindingError("PFG_BINDING_LOAD", `failed to load kernel addon ${addonPath}`, { cause });
    }
    if (!isRecord(raw)
        || typeof raw.BINDING_ABI_VERSION !== "number"
        || typeof raw.bindingTarget !== "function"
        || typeof raw.buildKernelIndex !== "function"
        || typeof raw.buildKernelIndexWithSourceDigest !== "function"
        || typeof raw.hashSourceContents !== "function"
        || typeof raw.KernelIndex !== "function"
        || typeof raw.KernelIndex.open !== "function"
        || typeof raw.KernelIndex.prototype?.queryRegexCandidates !== "function"
        || typeof raw.KernelIndex.prototype?.verifyRegexCandidates !== "function"
        || typeof raw.KernelIndex.prototype?.cancelRegexVerification !== "function"
        || typeof raw.KernelIndex.prototype?.verifyLiteralCandidates !== "function") {
        throw new KernelBindingError("PFG_BINDING_SHAPE", `kernel addon exports do not match ABI ${KERNEL_BINDING_ABI_VERSION}`);
    }
    if (raw.BINDING_ABI_VERSION !== KERNEL_BINDING_ABI_VERSION) {
        throw new KernelBindingError("PFG_BINDING_ABI", `kernel addon ABI ${raw.BINDING_ABI_VERSION} does not match ${KERNEL_BINDING_ABI_VERSION}`);
    }
    const actualTarget = raw.bindingTarget();
    const expectedTarget = expectedRustTarget();
    if (actualTarget !== expectedTarget) {
        throw new KernelBindingError("PFG_BINDING_TARGET", `kernel addon target ${String(actualTarget)} does not match ${expectedTarget}`);
    }
    return raw;
}
export function bigintToSafeNumber(value, field) {
    if (typeof value !== "bigint"
        || value < 0n
        || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new KernelBindingError("PFG_RANGE_UNSAFE", `${field} is not a non-negative safe JavaScript integer`);
    }
    return Number(value);
}
export function nativeKernelErrorCode(error) {
    if (!(error instanceof Error))
        return undefined;
    return /\[(PFG_[A-Z_]+)\]/u.exec(error.message)?.[1];
}
