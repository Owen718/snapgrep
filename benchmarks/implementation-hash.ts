import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const IMPLEMENTATION_HASH_SCHEMA_VERSION = "pi-fast-grep-implementation-hash/v1" as const;
export const IMPLEMENTATION_HASH_ALGORITHM = "sha256" as const;
export const IMPLEMENTATION_HASH_SOURCE_GLOBS = ["src/**/*.ts"] as const;
export const IMPLEMENTATION_HASH_EXTENSION_SURFACES = [
  ".pi/extensions/fast-grep.ts",
  ".pi/extensions/trace.ts",
] as const;
export const IMPLEMENTATION_HASH_HARNESS_SURFACES = [
  "benchmarks/implementation-hash.ts",
  "benchmarks/run.ts",
] as const;
export const IMPLEMENTATION_HASH_DEPENDENCY_SURFACES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
] as const;
export const IMPLEMENTATION_HASH_FIXED_SURFACES = [
  ...IMPLEMENTATION_HASH_EXTENSION_SURFACES,
  ...IMPLEMENTATION_HASH_HARNESS_SURFACES,
  ...IMPLEMENTATION_HASH_DEPENDENCY_SURFACES,
] as const;
export const IMPLEMENTATION_HASH_CONTRACT =
  "SHA-256 over the schema tag and every sorted workspace-relative UTF-8 path plus its exact file bytes, " +
  "with byte-length framing. The surface is every src/**/*.ts file plus the fixed extension, benchmark " +
  "runner, dependency lock, and TypeScript configuration files listed in fixedSurfaces.";

export interface ImplementationHashEvidence {
  schemaVersion: typeof IMPLEMENTATION_HASH_SCHEMA_VERSION;
  algorithm: typeof IMPLEMENTATION_HASH_ALGORITHM;
  contract: typeof IMPLEMENTATION_HASH_CONTRACT;
  sourceGlobs: string[];
  fixedSurfaces: string[];
  surfaces: string[];
  sha256: string;
}

const defaultWorkspaceRoot = path.resolve(import.meta.dirname, "..");

function posixRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function listTypeScriptFiles(root: string, relativeDirectory: string): string[] {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const surfaces: string[] = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relative = posixRelativePath(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) {
      surfaces.push(...listTypeScriptFiles(root, relative));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      surfaces.push(relative);
      continue;
    }
    if (entry.isSymbolicLink() && entry.name.endsWith(".ts")) {
      throw new Error(`implementation hash refuses symbolic-link TypeScript surface ${relative}`);
    }
  }
  return surfaces;
}

/**
 * Resolve the complete, deterministic implementation surface. Paths are
 * workspace-relative POSIX strings so the same checkout hashes identically on
 * every supported host.
 */
export function implementationHashSurfaces(workspaceRoot = defaultWorkspaceRoot): string[] {
  const root = path.resolve(workspaceRoot);
  const surfaces = [
    ...listTypeScriptFiles(root, "src"),
    ...IMPLEMENTATION_HASH_FIXED_SURFACES,
  ].sort();
  if (new Set(surfaces).size !== surfaces.length) {
    throw new Error("implementation hash surface contains duplicate paths");
  }
  return surfaces;
}

function updateLengthFramed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
}

/** Compute the exact implementation/harness evidence bound to workflow runs. */
export function computeImplementationHash(workspaceRoot = defaultWorkspaceRoot): ImplementationHashEvidence {
  const root = path.resolve(workspaceRoot);
  const surfaces = implementationHashSurfaces(root);
  const hash = createHash(IMPLEMENTATION_HASH_ALGORITHM);
  updateLengthFramed(hash, IMPLEMENTATION_HASH_SCHEMA_VERSION);
  updateLengthFramed(hash, IMPLEMENTATION_HASH_CONTRACT);
  for (const surface of surfaces) {
    updateLengthFramed(hash, surface);
    updateLengthFramed(hash, readFileSync(path.join(root, surface)));
  }
  return {
    schemaVersion: IMPLEMENTATION_HASH_SCHEMA_VERSION,
    algorithm: IMPLEMENTATION_HASH_ALGORITHM,
    contract: IMPLEMENTATION_HASH_CONTRACT,
    sourceGlobs: [...IMPLEMENTATION_HASH_SOURCE_GLOBS],
    fixedSurfaces: [...IMPLEMENTATION_HASH_FIXED_SURFACES],
    surfaces,
    sha256: hash.digest("hex"),
  };
}

function exactStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => typeof value === "string" && value === expected[index]);
}

/**
 * Validate serialized evidence against a freshly computed or caller-pinned
 * value. Missing v1 fields make pre-contract manifests fail closed.
 */
export function assertImplementationHashEvidence(
  actual: unknown,
  expected = computeImplementationHash(),
  label = "implementation hash evidence",
): asserts actual is ImplementationHashEvidence {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    throw new Error(`${label} is missing the ${IMPLEMENTATION_HASH_SCHEMA_VERSION} contract`);
  }
  const evidence = actual as Record<string, unknown>;
  if (
    evidence.schemaVersion !== expected.schemaVersion ||
    evidence.algorithm !== expected.algorithm ||
    evidence.contract !== expected.contract ||
    !exactStrings(evidence.sourceGlobs, expected.sourceGlobs) ||
    !exactStrings(evidence.fixedSurfaces, expected.fixedSurfaces) ||
    !exactStrings(evidence.surfaces, expected.surfaces) ||
    typeof evidence.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(evidence.sha256) ||
    evidence.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} does not match the current ${IMPLEMENTATION_HASH_SCHEMA_VERSION} contract`);
  }
}
