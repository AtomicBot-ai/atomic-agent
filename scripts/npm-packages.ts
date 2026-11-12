/**
 * Stages the npm packages of a CLI release from its bundles (the pure part
 * and the layout are in npm-packaging.ts; the publishing in
 * .github/workflows/npm.yml).
 *
 *   npx tsx scripts/npm-packages.ts stage --version 0.7.1 --archives dl --out dist/npm
 *
 * `--archives` holds the release's `atomic-agent-<slug>.tar.gz|zip` with their
 * `.sha256` files (`gh release download vX.Y.Z -p 'atomic-agent-*'`). Every
 * target whose archive is there becomes `<out>/<slug>/`, a package with the
 * unpacked bundle; `<out>/atomic-agent/` is the launcher depending on them.
 * `<out>/publish-order.txt` lists the directories in the order to publish.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { BUNDLE_TARGETS, type BundleTarget } from "./bundle-targets.js";
import {
  LAUNCHER_PACKAGE,
  archiveName,
  launcherManifest,
  platformManifest,
  publishOrder,
  sanitizeBundledManifest,
  type Manifest,
} from "./npm-packaging.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LAUNCHER_TEMPLATE = join(ROOT, "packaging", "npm", LAUNCHER_PACKAGE);

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

/** The archive's sha256 must match the `.sha256` file published beside it. */
function verifyDigest(archive: string): void {
  const digestFile = `${archive}.sha256`;
  if (!existsSync(digestFile)) throw new Error(`missing ${digestFile}`);
  const expected = readFileSync(digestFile, "utf8").trim().split(/\s+/, 1)[0]!.toLowerCase();
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== expected) {
    throw new Error(`${archive}: sha256 ${actual} does not match ${digestFile} (${expected})`);
  }
}

/**
 * Unpacks a bundle into `dest`. The tarballs hold `./<slug>/…` (package-bundle.ts
 * archives the staging directory), the Windows zip holds the files at its root.
 */
function unpack(archive: string, target: BundleTarget, dest: string): void {
  // Beside `dest`, not in the system temp dir: renameSync cannot cross filesystems.
  mkdirSync(join(dest, ".."), { recursive: true });
  const scratch = mkdtempSync(join(dest, "..", `.unpack-${target.slug}-`));
  try {
    if (target.archiveExt === "tar.gz") {
      run("tar", ["-xzf", archive, "-C", scratch]);
    } else {
      run("unzip", ["-q", archive, "-d", scratch]);
    }
    const nested = join(scratch, target.slug);
    const tree = existsSync(join(nested, target.executableName)) ? nested : scratch;
    if (!existsSync(join(tree, target.executableName))) {
      throw new Error(`${archive}: no ${target.executableName} in the bundle`);
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(tree, dest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Sanitises the bundle's node_modules/ in place; returns name → version. */
function prepareBundled(pkgDir: string): Record<string, string> {
  const modules = join(pkgDir, "node_modules");
  if (!existsSync(modules)) return {};
  const names = readdirSync(modules).filter(
    (name) => !name.startsWith(".") && existsSync(join(modules, name, "package.json")),
  );
  if (names.some((name) => name.startsWith("@"))) {
    throw new Error(`${modules}: scoped packages are not expected in the bundle`);
  }
  const bundled = new Set(names);
  const versions: Record<string, string> = {};
  for (const name of names) {
    const file = join(modules, name, "package.json");
    const manifest = readJson(file);
    versions[name] = String(manifest.version);
    writeJson(file, sanitizeBundledManifest(manifest, bundled));
  }
  return versions;
}

function stage(options: { version: string; archives: string; out: string }): number {
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const staged: string[] = [];
  for (const target of BUNDLE_TARGETS) {
    const archive = join(options.archives, archiveName(target));
    if (!existsSync(archive)) {
      stdout.write(`skip ${target.slug}: no ${archiveName(target)}\n`);
      continue;
    }
    verifyDigest(archive);
    const pkgDir = join(out, target.slug);
    unpack(archive, target, pkgDir);
    const bundled = prepareBundled(pkgDir);
    writeJson(
      join(pkgDir, "package.json"),
      platformManifest({ slug: target.slug, version: options.version, bundled }),
    );
    writeFileSync(
      join(pkgDir, "README.md"),
      `# ${target.slug} binary of atomic-agent\n\nInstall [atomic-agent](https://www.npmjs.com/package/atomic-agent) instead: \`npm install -g atomic-agent\`. It depends on this package on ${target.slug} and runs the binary in it.\n`,
      "utf8",
    );
    staged.push(target.slug);
    stdout.write(`staged ${pkgDir} (bundled: ${Object.keys(bundled).join(", ") || "none"})\n`);
  }
  if (staged.length === 0) {
    stderr.write(`no release bundles under ${options.archives}\n`);
    return 1;
  }

  const launcherDir = join(out, LAUNCHER_PACKAGE);
  rmSync(launcherDir, { recursive: true, force: true });
  cpSync(LAUNCHER_TEMPLATE, launcherDir, { recursive: true });
  cpSync(join(ROOT, "LICENSE"), join(launcherDir, "LICENSE"));
  writeJson(
    join(launcherDir, "package.json"),
    launcherManifest(readJson(join(LAUNCHER_TEMPLATE, "package.json")), options.version, staged),
  );
  writeFileSync(join(out, "publish-order.txt"), `${publishOrder(staged).join("\n")}\n`, "utf8");
  stdout.write(`staged ${launcherDir}\npublish order: ${publishOrder(staged).join(", ")}\n`);
  return 0;
}

function main(): number {
  const [command, ...rest] = argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      version: { type: "string" },
      archives: { type: "string" },
      out: { type: "string" },
    },
  });
  if (command !== "stage" || !values.version || !values.archives || !values.out) {
    stderr.write("usage: npm-packages.ts stage --version X.Y.Z --archives <dir> --out <dir>\n");
    return 2;
  }
  return stage({ version: values.version, archives: values.archives, out: values.out });
}

try {
  exit(main());
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
