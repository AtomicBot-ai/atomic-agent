/**
 * Build the atomic-agent deb and rpm from the release bundles with nfpm, and render the AUR
 * PKGBUILD. Names, versions and the PKGBUILD filling are in linux-packaging.ts.
 *
 *   npx tsx scripts/linux-packages.ts build [--version X.Y.Z] [--archives bundle] [--out dist/pkg]
 *   npx tsx scripts/linux-packages.ts pkgbuild [--version X.Y.Z] [--archives bundle] [--source-base URL] [--out .]
 *
 * `build` runs on Linux (it needs nfpm, tar and readelf from binutils) for both architectures at
 * once: a package is the release archive `atomic-agent-<slug>.tar.gz` extracted under
 * /usr/lib/atomic-agent, nothing is compiled or run. It signs the rpm when RPM_SIGNING_KEY_FILE
 * names an armored private key (its passphrase in NFPM_RPM_PASSPHRASE); unset, the rpm is unsigned
 * (a dry run). Each package gets a `<name>.sha256` beside it, as the bundles have.
 *
 * `pkgbuild` reads the archives' `.sha256` digests (`package-bundle.ts` writes them) and fills
 * packaging/PKGBUILD.in. `--source-base` defaults to the release's download URL on GitHub.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import {
  archiveAsset,
  GITHUB_REPO,
  glibcFloor,
  maxGlibc,
  PACKAGE_FORMATS,
  PACKAGE_TARGETS,
  packageFileName,
  parseSha256File,
  renderPkgbuild,
  type PackageTarget,
} from "./linux-packaging.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The ELF files of a bundle whose glibc requirements decide the package's dependency. */
const ELF_FILES = [
  "atomic-agent",
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "vendor/rg",
];

function fail(message: string): never {
  stderr.write(`linux-packages: ${message}\n`);
  exit(1);
}

function option(name: string, fallback: string): string;
function option(name: string): string | undefined;
function option(name: string, fallback?: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const res = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });
  if (res.error) fail(`${command}: ${res.error.message}`);
  if (res.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${res.stderr ?? ""}`);
  return res.stdout;
}

const version = option("version", (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version);

function archivePath(archives: string, target: PackageTarget): string {
  const path = join(archives, archiveAsset(target));
  if (!existsSync(path)) fail(`${path} is missing; build or download the release bundle first`);
  return path;
}

/** Extract a bundle; its single top-level directory is the slug. */
function extractBundle(archive: string, target: PackageTarget, into: string): string {
  mkdirSync(into, { recursive: true });
  run("tar", ["-xzf", archive, "-C", into]);
  const tree = join(into, target.slug);
  if (!existsSync(join(tree, "atomic-agent"))) fail(`${archive} has no ${target.slug}/atomic-agent`);
  // Modes travel in the archive, but a bundle re-packed on the way here may have lost them.
  chmodSync(join(tree, "atomic-agent"), 0o755);
  if (existsSync(join(tree, "vendor", "rg"))) chmodSync(join(tree, "vendor", "rg"), 0o755);
  return tree;
}

/** The newest glibc any ELF file of the tree requires; the binary itself must name one. */
function treeGlibc(tree: string): string {
  const floors = ELF_FILES.filter((f) => existsSync(join(tree, f))).map((f) => {
    const floor = glibcFloor(run("readelf", ["--version-info", "--wide", join(tree, f)]));
    stdout.write(`  ${f}: glibc ${floor ?? "(none, static)"}\n`);
    return floor;
  });
  const floor = maxGlibc(floors);
  if (!floor) fail(`${tree}/atomic-agent references no GLIBC_ version`);
  return floor;
}

function writeDigest(file: string): void {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${hash}  ${basename(file)}\n`, "utf8");
}

function build(): void {
  const archives = resolve(option("archives", join(ROOT, "bundle")));
  const out = resolve(option("out", join(ROOT, "dist", "pkg")));
  const stage = mkdtempSync(join(tmpdir(), "atomic-agent-pkg-"));
  try {
    const trees = PACKAGE_TARGETS.map((target) => {
      const tree = extractBundle(archivePath(archives, target), target, join(stage, target.slug));
      stdout.write(`${target.slug}: ${tree}\n`);
      return { target, tree, glibc: treeGlibc(tree) };
    });
    mkdirSync(out, { recursive: true });
    for (const format of PACKAGE_FORMATS) {
      // nfpm reads the marker from the stage; each format writes its own name into it.
      writeFileSync(join(stage, "install-source"), `${format}\n`, "utf8");
      for (const { target, tree, glibc } of trees) {
        const file = join(out, packageFileName(version, format, target));
        run(
          "nfpm",
          ["package", "--config", "packaging/nfpm.yaml", "--packager", format, "--target", file],
          {
            cwd: ROOT,
            env: {
              ...env,
              VERSION: version,
              ARCH: target.nfpm,
              TREE: tree,
              GLIBC: glibc,
              STAGE: stage,
              RPM_SIGNING_KEY_FILE: env.RPM_SIGNING_KEY_FILE ?? "",
            },
          },
        );
        writeDigest(file);
        stdout.write(`built ${file} (glibc >= ${glibc})\n`);
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function pkgbuild(): void {
  const archives = resolve(option("archives", join(ROOT, "bundle")));
  const sourceBase = option("source-base", `https://github.com/${GITHUB_REPO}/releases/download/v${version}`);
  const out = resolve(option("out", "."));
  const sums: Record<string, string> = {};
  for (const target of PACKAGE_TARGETS) {
    const name = archiveAsset(target);
    const digest = join(archives, `${name}.sha256`);
    if (!existsSync(digest)) fail(`${digest} is missing; download the release's digests first`);
    sums[target.slug] = parseSha256File(readFileSync(digest, "utf8"), name);
  }
  const template = readFileSync(join(ROOT, "packaging", "PKGBUILD.in"), "utf8");
  let text: string;
  try {
    text = renderPkgbuild(template, { version, sums, sourceBase });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "PKGBUILD"), text, "utf8");
  stdout.write(`wrote ${join(out, "PKGBUILD")} for atomic-agent ${version}\n`);
}

const command = argv[2];
if (command === "build") build();
else if (command === "pkgbuild") pkgbuild();
else fail("usage: linux-packages.ts build|pkgbuild [options]; see the header of this file");
