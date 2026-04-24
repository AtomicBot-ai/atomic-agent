/**
 * Fetch runtime assets required by the release bundle (Node SEA CLI / ripgrep).
 *
 * Currently the only external asset we pre-download is `ripgrep`, which
 * powers `os.fs.grep`. We bundle one binary per supported target under
 * `assets/ripgrep/<slug>/rg[.exe]`; `scripts/package-bundle.ts` then
 * copies the matching binary into `<stageDir>/vendor/rg[.exe]` next to
 * the SEA executable. At runtime `src/runtime/ripgrep-resolver.ts`
 * discovers it automatically.
 *
 * Pin the ripgrep version + per-target archive URL here. Update the
 * `RIPGREP_VERSION` constant when refreshing to a new release.
 *
 * Usage:
 *   npx tsx scripts/fetch-assets.ts           # fetch for current host
 *   npx tsx scripts/fetch-assets.ts --all     # fetch for every target
 *   npx tsx scripts/fetch-assets.ts --force   # re-download even if cached
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { argv, exit, platform, stdout, stderr } from "node:process";
import { join, resolve } from "node:path";
import {
  BUNDLE_TARGETS,
  currentTarget,
  type BundleTarget,
} from "./bundle-targets.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RIPGREP_VERSION = "14.1.1";
const RIPGREP_BASE_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;

interface RipgrepAsset {
  archive: string;
  /** Path to `rg[.exe]` inside the extracted archive. */
  innerPath: string;
  format: "tar.gz" | "zip";
}

function ripgrepAssetFor(target: BundleTarget): RipgrepAsset {
  const v = RIPGREP_VERSION;
  switch (target.slug) {
    case "darwin-arm64":
      return {
        archive: `ripgrep-${v}-aarch64-apple-darwin.tar.gz`,
        innerPath: `ripgrep-${v}-aarch64-apple-darwin/rg`,
        format: "tar.gz",
      };
    case "darwin-x64":
      return {
        archive: `ripgrep-${v}-x86_64-apple-darwin.tar.gz`,
        innerPath: `ripgrep-${v}-x86_64-apple-darwin/rg`,
        format: "tar.gz",
      };
    case "linux-x64":
      return {
        archive: `ripgrep-${v}-x86_64-unknown-linux-musl.tar.gz`,
        innerPath: `ripgrep-${v}-x86_64-unknown-linux-musl/rg`,
        format: "tar.gz",
      };
    case "linux-arm64":
      return {
        archive: `ripgrep-${v}-aarch64-unknown-linux-gnu.tar.gz`,
        innerPath: `ripgrep-${v}-aarch64-unknown-linux-gnu/rg`,
        format: "tar.gz",
      };
    case "win32-x64":
      return {
        archive: `ripgrep-${v}-x86_64-pc-windows-msvc.zip`,
        innerPath: `ripgrep-${v}-x86_64-pc-windows-msvc/rg.exe`,
        format: "zip",
      };
    default:
      throw new Error(`no ripgrep asset mapping for target ${target.slug}`);
  }
}

interface Options {
  force: boolean;
  all: boolean;
}

function parseArgs(args: string[]): Options {
  return {
    force: args.includes("--force") || args.includes("-f"),
    all: args.includes("--all") || args.includes("-a"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, destFile: string): Promise<void> {
  stdout.write(`  download: ${url}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed ${response.status} ${response.statusText}: ${url}`);
  }
  await mkdir(resolve(destFile, ".."), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    createWriteStream(destFile),
  );
}

async function runSpawn(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolveCmd, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveCmd()
        : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await runSpawn("tar", ["-xzf", archivePath, "-C", destDir], ROOT);
}

async function extractZip(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const isWindowsHost = platform === "win32";
  if (isWindowsHost) {
    await runSpawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ],
      ROOT,
    );
  } else {
    await runSpawn("unzip", ["-o", "-q", archivePath, "-d", destDir], ROOT);
  }
}

async function fetchRipgrepForTarget(
  target: BundleTarget,
  options: Options,
): Promise<void> {
  const asset = ripgrepAssetFor(target);
  const outDir = join(ROOT, "assets", "ripgrep", target.slug);
  const binaryName = target.platform === "win32" ? "rg.exe" : "rg";
  const outBinary = join(outDir, binaryName);

  if (!options.force && (await pathExists(outBinary))) {
    stdout.write(`fetch-assets: ${target.slug} → ${binaryName} (cached)\n`);
    return;
  }

  stdout.write(`fetch-assets: ${target.slug} → ${binaryName} (fetching)\n`);
  const tmpDir = join(ROOT, "assets", "ripgrep", `.tmp-${target.slug}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const archivePath = join(tmpDir, asset.archive);
  await downloadFile(`${RIPGREP_BASE_URL}/${asset.archive}`, archivePath);

  if (asset.format === "tar.gz") {
    await extractTarGz(archivePath, tmpDir);
  } else {
    await extractZip(archivePath, tmpDir);
  }

  const extractedBinary = join(tmpDir, asset.innerPath);
  if (!(await pathExists(extractedBinary))) {
    throw new Error(
      `extracted archive did not contain expected path ${asset.innerPath}`,
    );
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(outBinary, await readBinary(extractedBinary));
  if (target.platform !== "win32") {
    await chmod(outBinary, 0o755);
  }
  await rm(tmpDir, { recursive: true, force: true });
  stdout.write(`fetch-assets: ${target.slug} → ${outBinary}\n`);
}

async function readBinary(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

async function main(): Promise<number> {
  const opts = parseArgs(argv.slice(2));
  const targets = opts.all ? BUNDLE_TARGETS : [currentTarget()];
  stdout.write(
    `fetch-assets: ripgrep ${RIPGREP_VERSION} for ${targets.length} target(s)\n`,
  );
  for (const target of targets) {
    await fetchRipgrepForTarget(target, opts);
  }
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    stderr.write(`${msg}\n`);
    exit(1);
  });
