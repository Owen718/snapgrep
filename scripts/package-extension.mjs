import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(repoRoot, "dist", "src");
const platformTarget = `${process.platform}-${process.arch}`;
const addonName = `pi-fast-grep-kernel.${platformTarget}.node`;
const addonSource = path.join(repoRoot, "native", "kernel", "binding", addonName);
const outputRoot = path.join(repoRoot, "artifacts", "pi-extension");
const outputDirectory = path.join(outputRoot, "pi-fast-grep");
const packageSource = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

const sourceStat = await stat(sourceDirectory).catch(() => undefined);
if (!sourceStat?.isDirectory()) {
  throw new Error("compiled extension is missing; run npm run build first");
}
const addonStat = await stat(addonSource).catch(() => undefined);
if (!addonStat?.isFile()) {
  throw new Error(`native addon is missing for ${platformTarget}; run npm run build:kernel first`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.join(outputDirectory, "src"), { recursive: true });
await mkdir(path.join(outputDirectory, "native"), { recursive: true });

for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    await cp(path.join(sourceDirectory, entry.name), path.join(outputDirectory, "src", entry.name));
  }
}
await cp(addonSource, path.join(outputDirectory, "native", addonName));
await cp(
  path.join(repoRoot, "packaging", "pi-extension", "INSTALL.zh-CN.md"),
  path.join(outputDirectory, "安装说明.md"),
);
await cp(
  path.join(repoRoot, "packaging", "pi-extension", "artifact.gitignore"),
  path.join(outputDirectory, ".gitignore"),
);

const artifactPackage = {
  name: "pi-fast-grep-extension",
  version: packageSource.version,
  private: true,
  type: "module",
  main: "./src/packaged-extension.js",
  exports: { ".": "./src/packaged-extension.js" },
  files: ["src/*.js", "native/*.node", ".gitignore", "安装说明.md"],
  pi: { extensions: ["./src/packaged-extension.js"] },
  engines: { node: packageSource.engines.node },
};
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify(artifactPackage, undefined, 2)}\n`,
);

process.stdout.write(`${outputDirectory}\n`);
