import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(repoRoot, "dist", "src");
const platformTarget = `${process.platform}-${process.arch}`;
const bindingDirectory = path.join(repoRoot, "native", "kernel", "binding");
const outputRoot = path.join(repoRoot, "artifacts", "pi-extension");
const outputDirectory = path.join(outputRoot, "pi-fast-grep");
const packageSource = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

const sourceStat = await stat(sourceDirectory).catch(() => undefined);
if (!sourceStat?.isDirectory()) {
  throw new Error("compiled extension is missing; run npm run build first");
}
// Ship every addon present in the binding directory, not just this machine's.
// CI builds each platform on its own runner and collects them here before
// packaging, so the artifact serves every target it was built for.
const addonNames = (await readdir(bindingDirectory).catch(() => []))
  .filter((name) => name.startsWith("pi-fast-grep-kernel.") && name.endsWith(".node"))
  .sort();
if (addonNames.length === 0) {
  throw new Error("no native addon was found; run npm run build:kernel first");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.join(outputDirectory, "src"), { recursive: true });
await mkdir(path.join(outputDirectory, "native"), { recursive: true });

for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    await cp(path.join(sourceDirectory, entry.name), path.join(outputDirectory, "src", entry.name));
  }
}
for (const name of addonNames) {
  await cp(path.join(bindingDirectory, name), path.join(outputDirectory, "native", name));
}
if (!addonNames.includes(`pi-fast-grep-kernel.${platformTarget}.node`)) {
  process.stderr.write(
    `note: packaged ${addonNames.length} addon(s), none of them for this machine (${platformTarget})\n`,
  );
}
await cp(
  path.join(repoRoot, "packaging", "pi-extension", "INSTALL.zh-CN.md"),
  path.join(outputDirectory, "安装说明.md"),
);
await cp(
  path.join(repoRoot, "packaging", "pi-extension", "artifact.gitignore"),
  path.join(outputDirectory, ".gitignore"),
);
await cp(
  path.join(repoRoot, "packaging", "pi-extension", "cordis.patch.yml"),
  path.join(outputDirectory, "cordis.patch.yml"),
);

const artifactPackage = {
  name: "pi-fast-grep-extension",
  version: packageSource.version,
  private: true,
  type: "module",
  main: "./src/packaged-extension.js",
  exports: {
    ".": "./src/packaged-extension.js",
    // DeepSeek Harness mounts a plugin by module name, so the Cordis entry
    // needs its own export path.
    "./dsh": "./src/dsh-plugin.js",
  },
  files: ["src/*.js", "native/*.node", ".gitignore", "cordis.patch.yml", "安装说明.md"],
  pi: { extensions: ["./src/packaged-extension.js"] },
  // Declaring a bundle patch is what makes `dsh plugin add` mount this as a
  // profile layer; without it the harness installs the package and leaves it
  // inert.
  dsh: { bundle: { patch: "./cordis.patch.yml" } },
  engines: { node: packageSource.engines.node },
};
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify(artifactPackage, undefined, 2)}\n`,
);

process.stdout.write(`${outputDirectory}\n`);
