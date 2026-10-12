#!/usr/bin/env node
/**
 * Fetch the Atomic Chat Core binary the installer carries.
 *
 *   node scripts/fetch-core.mjs                                 # this machine
 *   node scripts/fetch-core.mjs --platform darwin --arch arm64
 *   node scripts/fetch-core.mjs --slug win32-arm64               # CI's matrix slug
 *   ATAG_CORE_PLATFORM=win32 ATAG_CORE_ARCH=x64 node scripts/fetch-core.mjs
 *
 * Writes `desktop/build/core/<platform>-<arch>/atomic-chat-core[.exe]`, which
 * electron-builder.cjs ships as `<resources>/core/` for that target, and
 * main/core-seed.ts copies into the agent's data dir on first launch. So the
 * first run of the app needs no Core download from GitHub, and the copy that
 * runs is the one our own certificate signed (CI signs this file before
 * packaging on Windows; electron-builder signs it with the app on macOS).
 *
 * The release's SHA256SUMS is the trust anchor, checked HERE, at build time:
 * the asset must hash to exactly the one line naming it, or the build fails.
 * After signing the bytes differ from the release, which is why the app
 * records the hash of its own on-disk copy rather than the release's.
 *
 * Platform and arch take Node's names (darwin | win32 | linux, x64 | arm64),
 * electron-builder's (mac | win), and the release's (x86_64 | aarch64).
 * No dependencies: Node's fetch follows GitHub's redirect to the asset host.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const OUT_ROOT = join(DESKTOP, "build", "core");
const REPO = "AtomicBot-ai/atomic-chat-core";

/** The single source is main/core-bundle.ts; read it as text so this script stays dependency-free. */
export function bundledCoreVersion() {
  const src = readFileSync(join(DESKTOP, "main", "core-bundle.ts"), "utf8");
  const m = src.match(/export const BUNDLED_CORE_VERSION = "(\d+\.\d+\.\d+)";/);
  if (!m) throw new Error("fetch-core: BUNDLED_CORE_VERSION not found in main/core-bundle.ts");
  return m[1];
}

const PLATFORMS = { darwin: "darwin", mac: "darwin", macos: "darwin", osx: "darwin", win32: "win32", win: "win32", windows: "win32", linux: "linux" };
const ARCHES = { x64: "x64", x86_64: "x64", amd64: "x64", arm64: "arm64", aarch64: "arm64" };

export function normalizeTarget(platform, arch) {
  const p = PLATFORMS[String(platform).toLowerCase()];
  const a = ARCHES[String(arch).toLowerCase()];
  if (!p) throw new Error(`fetch-core: unknown platform "${platform}" (darwin, win32 or linux)`);
  if (!a) throw new Error(`fetch-core: unknown arch "${arch}" (x64 or arm64; Core ships no universal or 32-bit build)`);
  return { platform: p, arch: a };
}

/** Same naming as coreAssetName() in src/local-llm/core/core-install.ts. */
export function coreAssetName(version, platform, arch) {
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const target = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-gnu" : "pc-windows-msvc.exe";
  return `atomic-chat-core-${version}-${cpu}-${target}`;
}

export function outputPath(platform, arch) {
  return join(OUT_ROOT, `${platform}-${arch}`, platform === "win32" ? "atomic-chat-core.exe" : "atomic-chat-core");
}

/** The hash on the one SHA256SUMS line for `asset`; anything but exactly one match fails. */
export function expectedSha(sums, asset) {
  const hits = sums
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/))
    .filter((m) => m && m[2] === asset);
  if (hits.length !== 1) throw new Error(`fetch-core: SHA256SUMS has ${hits.length} lines for ${asset}, expected exactly 1`);
  return hits[0][1].toLowerCase();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=", 2);
    const take = () => (inline !== undefined ? inline : argv[++i]);
    if (key === "--platform") out.platform = take();
    else if (key === "--arch") out.arch = take();
    else if (key === "--slug") out.slug = take();
    else throw new Error(`fetch-core: unknown argument ${argv[i]}`);
  }
  return out;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetries(what, fn, attempts = 4) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err?.fatal || i === attempts) break;
      console.log(`fetch-core: ${what} failed (${err?.message ?? err}); retry ${i}/${attempts - 1}`);
      await sleep(2000 * i);
    }
  }
  throw last;
}

async function get(url, timeoutMs) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "atomic-agent-desktop-build" } });
  if (!res.ok) {
    const err = new Error(`GET ${url} -> HTTP ${res.status}`);
    err.fatal = res.status === 404; // a wrong version or asset name will not appear on a retry
    throw err;
  }
  return res;
}

/** Download `url` to `dest`, hashing on the way. Returns the hex sha256. */
async function download(url, dest) {
  const hash = createHash("sha256");
  const res = await get(url, 15 * 60_000);
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(dest, { mode: 0o755 }));
  return hash.digest("hex");
}

export async function fetchCore({ platform, arch, version = bundledCoreVersion() }) {
  const asset = coreAssetName(version, platform, arch);
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const dest = outputPath(platform, arch);

  const sums = await withRetries("SHA256SUMS", async () => (await get(`${base}/SHA256SUMS`, 30_000)).text());
  const expected = expectedSha(sums, asset);

  if (existsSync(dest) && (await sha256File(dest)) === expected) {
    console.log(`fetch-core: ${asset} already at ${dest} (sha256 ${expected})`);
    return dest;
  }

  await mkdir(dirname(dest), { recursive: true });
  /* Staged next to OUT_ROOT, not inside the target dir: electron-builder
     ships that whole dir, and a half-written file must never be in it. */
  const stage = join(OUT_ROOT, `.download-${platform}-${arch}-${process.pid}`);
  try {
    await withRetries(asset, async () => {
      await rm(stage, { force: true });
      const got = await download(`${base}/${asset}`, stage);
      if (got !== expected) {
        const err = new Error(`fetch-core: ${asset} sha256 ${got} does not match SHA256SUMS ${expected}`);
        err.fatal = true;
        throw err;
      }
    });
    if (platform !== "win32") await chmod(stage, 0o755);
    await rm(dest, { force: true });
    await rename(stage, dest);
  } finally {
    await rm(stage, { force: true });
  }
  console.log(`fetch-core: ${asset} -> ${dest} (sha256 ${expected})`);
  return dest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let platform = args.platform ?? process.env.ATAG_CORE_PLATFORM;
  let arch = args.arch ?? process.env.ATAG_CORE_ARCH;
  if (args.slug) [platform, arch] = args.slug.split("-", 2);
  const target = normalizeTarget(platform ?? process.platform, arch ?? process.arch);
  await fetchCore(target);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
