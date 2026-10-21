// Unit tests for main/studio-core-install.ts, against the built output.
// Run: npm run build && npm run test:unit
// Studio puts Atomic Core in place when nothing else has (a cloud-route
// install), the way the agent's installCore does: same asset name, the
// release's SHA256SUMS, the same verified.json. No network: fetch and the
// `--version` probe are stood in.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  coreAssetName, coreChecksum, coreVerifiedRecord, coreReleaseBase, installStudioCore, isStudioCoreInstalled, CoreInstallError,
} = require("../out/main/studio-core-install.js");

const VERSION = "0.18.6";
const WIN = process.platform === "win32";
const NAME = WIN ? "atomic-chat-core.exe" : "atomic-chat-core";
const BINARY = Buffer.from("atomic chat core release binary\n".repeat(64));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const ASSET = coreAssetName(VERSION);
const runs = async () => ({ version: VERSION });

const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function dataDir() {
  const root = mkdtempSync(join(tmpdir(), "studio-core-install-"));
  roots.push(root);
  return join(root, "models");
}

/** A fetch that serves SHA256SUMS and the asset from memory, and records what was asked. */
function fakeRelease({ sums, body = BINARY, status = 200, sumsStatus = 200 } = {}) {
  const asked = [];
  const base = coreReleaseBase(VERSION);
  const request = async (url) => {
    asked.push(String(url));
    if (url === `${base}/SHA256SUMS`) {
      return new Response(sums ?? `${sha(BINARY)}  ${ASSET}\n${"0".repeat(64)}  atomic-chat-core-${VERSION}-other\n`, { status: sumsStatus });
    }
    if (url === `${base}/${ASSET}`) {
      return new Response(status === 200 ? body : "nope", { status, headers: status === 200 ? { "content-length": String(body.length) } : {} });
    }
    return new Response("not found", { status: 404 });
  };
  return { request, asked };
}

test("asset names per platform and CPU match the agent's coreAssetName", () => {
  assert.equal(coreAssetName("0.18.6", "darwin", "arm64"), "atomic-chat-core-0.18.6-aarch64-apple-darwin");
  assert.equal(coreAssetName("0.18.6", "darwin", "x64"), "atomic-chat-core-0.18.6-x86_64-apple-darwin");
  assert.equal(coreAssetName("0.18.6", "linux", "x64"), "atomic-chat-core-0.18.6-x86_64-unknown-linux-gnu");
  assert.equal(coreAssetName("0.18.6", "linux", "arm64"), "atomic-chat-core-0.18.6-aarch64-unknown-linux-gnu");
  assert.equal(coreAssetName("0.18.6", "win32", "x64"), "atomic-chat-core-0.18.6-x86_64-pc-windows-msvc.exe");
  assert.equal(coreAssetName("0.18.6", "win32", "arm64"), "atomic-chat-core-0.18.6-aarch64-pc-windows-msvc.exe");
  assert.throws(() => coreAssetName("0.18.6", "darwin", "ia32"), CoreInstallError);
  assert.throws(() => coreAssetName("0.18.6", "freebsd", "x64"), CoreInstallError);
});

test("SHA256SUMS: one line for the asset, any case, with or without the binary-mode star", () => {
  const h = "AB".repeat(32);
  const asset = "atomic-chat-core-0.18.6-aarch64-apple-darwin";
  const text = [
    `${"1".repeat(64)}  atomic-chat-core-0.18.6-x86_64-apple-darwin`,
    `${h} *${asset}`,
    "",
    "garbage line",
  ].join("\r\n");
  assert.equal(coreChecksum(text, asset), "ab".repeat(32));
  assert.equal(coreChecksum(`${"c".repeat(64)}  ${asset}\n`, asset), "c".repeat(64));
  // missing, ambiguous, or only a prefix of the name: refused
  assert.throws(() => coreChecksum(`${"1".repeat(64)}  other\n`, asset), CoreInstallError);
  assert.throws(() => coreChecksum(`${"1".repeat(64)}  ${asset}\n${"2".repeat(64)}  ${asset}\n`, asset), CoreInstallError);
  assert.throws(() => coreChecksum(`${"1".repeat(64)}  ${asset}.sig\n`, asset), CoreInstallError);
  assert.throws(() => coreChecksum(`${"1".repeat(63)}  ${asset}\n`, asset), CoreInstallError);
});

test("verified.json is byte for byte what the agent and core-seed.ts write", () => {
  const h = "d".repeat(64);
  assert.equal(coreVerifiedRecord("0.18.6", h), `{"version":"0.18.6","sha256":"${h}"}\n`);
  assert.deepEqual(Object.keys(JSON.parse(coreVerifiedRecord("0.18.6", h))), ["version", "sha256"]);
  assert.throws(() => coreVerifiedRecord("0.18.6", "D".repeat(64)), CoreInstallError);
});

test("a missing Core is downloaded, verified and placed where the agent looks", async () => {
  const dir = dataDir();
  const { request, asked } = fakeRelease();
  const progress = [];
  await installStudioCore(dir, VERSION, { request, probe: runs, onProgress: (p) => progress.push(p), retryDelayMs: 1 });
  const versionDir = join(dir, "core", "versions", VERSION);
  const binary = join(versionDir, NAME);
  assert.deepEqual(readFileSync(binary), BINARY);
  const record = readFileSync(join(versionDir, "verified.json"), "utf8");
  assert.equal(record, `{"version":"${VERSION}","sha256":"${sha(BINARY)}"}\n`);
  if (!WIN) {
    assert.equal(statSync(binary).mode & 0o777, 0o755);
    assert.equal(statSync(join(versionDir, "verified.json")).mode & 0o777, 0o600);
    assert.equal(statSync(versionDir).mode & 0o777, 0o700);
  }
  assert.deepEqual(readdirSync(versionDir).sort(), [NAME, "verified.json"].sort(), "no staging file left");
  assert.equal(await isStudioCoreInstalled(dir, VERSION), true);
  assert.ok(asked.every((u) => u.startsWith("https://github.com/AtomicBot-ai/atomic-chat-core/releases/download/v0.18.6/")));
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).transferred, BINARY.length);
});

test("a valid install is left alone and nothing is fetched", async () => {
  const dir = dataDir();
  const versionDir = join(dir, "core", "versions", VERSION);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, NAME), "theirs");
  writeFileSync(join(versionDir, "verified.json"), coreVerifiedRecord(VERSION, "e".repeat(64)));
  const { request, asked } = fakeRelease();
  await installStudioCore(dir, VERSION, { request, probe: runs });
  assert.equal(asked.length, 0);
  assert.equal(readFileSync(join(versionDir, NAME), "utf8"), "theirs");
});

test("bytes that do not match SHA256SUMS are discarded and nothing is placed", async () => {
  const dir = dataDir();
  const { request } = fakeRelease({ body: Buffer.from("tampered") });
  await assert.rejects(installStudioCore(dir, VERSION, { request, probe: runs, retryDelayMs: 1 }), (err) => err instanceof CoreInstallError && /checksum/.test(err.message));
  const versionDir = join(dir, "core", "versions", VERSION);
  assert.equal(existsSync(join(versionDir, NAME)), false);
  assert.equal(existsSync(join(versionDir, "verified.json")), false);
  assert.deepEqual(readdirSync(versionDir), []);
});

test("a binary that reports another version is not placed", async () => {
  const dir = dataDir();
  const { request } = fakeRelease();
  await assert.rejects(installStudioCore(dir, VERSION, { request, probe: async () => ({ version: "0.0.1" }), retryDelayMs: 1 }), CoreInstallError);
  assert.equal(await isStudioCoreInstalled(dir, VERSION), false);
});

test("a server error is retried three times, then says why", async () => {
  const dir = dataDir();
  const { request, asked } = fakeRelease({ sumsStatus: 503 });
  await assert.rejects(installStudioCore(dir, VERSION, { request, probe: runs, retryDelayMs: 1 }), (err) => err instanceof CoreInstallError && /HTTP 503/.test(err.message));
  assert.equal(asked.length, 3);
});

test("a 404 is not retried", async () => {
  const dir = dataDir();
  const { request, asked } = fakeRelease({ status: 404 });
  await assert.rejects(installStudioCore(dir, VERSION, { request, probe: runs, retryDelayMs: 1 }), (err) => /HTTP 404/.test(err.message));
  assert.equal(asked.filter((u) => u.endsWith(ASSET)).length, 1);
});

test("a cancelled install stops at once and places nothing", async () => {
  const dir = dataDir();
  const ac = new AbortController();
  ac.abort();
  const { request } = fakeRelease();
  await assert.rejects(installStudioCore(dir, VERSION, { request, probe: runs, signal: ac.signal, retryDelayMs: 1 }));
  assert.equal(await isStudioCoreInstalled(dir, VERSION), false);
});
