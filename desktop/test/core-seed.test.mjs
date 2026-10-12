// Unit tests for main/core-seed.ts, against the built output.
// Run: npm run build && npm run test:unit
// The installer's Atomic Chat Core is copied into the agent's data dir on
// first launch, in the layout the agent's isCoreInstalled accepts, and a
// valid install is never touched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { seedBundledCore } = require("../out/main/core-seed.js");
const { BUNDLED_CORE_VERSION, bundledCoreFileName } = require("../out/main/core-bundle.js");

const WIN = process.platform === "win32";
const NAME = bundledCoreFileName();
const BUNDLED = Buffer.from("bundled core binary, signed\n");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function fixture({ bundled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-seed-"));
  roots.push(root);
  const resources = join(root, "resources");
  mkdirSync(join(resources, "core"), { recursive: true });
  if (bundled) writeFileSync(join(resources, "core", NAME), BUNDLED);
  const dataDir = join(root, "models");
  const versionDir = join(dataDir, "core", "versions", BUNDLED_CORE_VERSION);
  return { resources, dataDir, versionDir, binary: join(versionDir, NAME), record: join(versionDir, "verified.json") };
}

test("an empty data dir gets the binary and a verified.json the agent accepts", async () => {
  const f = fixture();
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources });
  assert.deepEqual(res, { seeded: true });
  assert.deepEqual(readFileSync(f.binary), BUNDLED);
  const text = readFileSync(f.record, "utf8");
  assert.equal(text, JSON.stringify({ version: BUNDLED_CORE_VERSION, sha256: sha(BUNDLED) }) + "\n");
  assert.match(JSON.parse(text).sha256, /^[a-f0-9]{64}$/);
  if (!WIN) {
    assert.equal(statSync(f.binary).mode & 0o777, 0o755);
    assert.equal(statSync(f.record).mode & 0o777, 0o600);
    assert.equal(statSync(f.versionDir).mode & 0o777, 0o700);
  }
  // No temp files left beside it.
  assert.deepEqual(readdirSync(f.versionDir).sort(), [NAME, "verified.json"].sort());
});

test("a valid install is left exactly as it is", async () => {
  const f = fixture();
  mkdirSync(f.versionDir, { recursive: true });
  const theirs = Buffer.from("core the agent downloaded\n");
  const record = JSON.stringify({ version: BUNDLED_CORE_VERSION, sha256: "a".repeat(64) }) + "\n";
  writeFileSync(f.binary, theirs);
  writeFileSync(f.record, record);
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources });
  assert.equal(res.seeded, false);
  assert.match(res.reason, /already installed/);
  assert.deepEqual(readFileSync(f.binary), theirs);
  assert.equal(readFileSync(f.record, "utf8"), record);
});

test("a binary without verified.json is not an install: it is re-seeded", async () => {
  const f = fixture();
  mkdirSync(f.versionDir, { recursive: true });
  writeFileSync(f.binary, "half an install\n");
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources });
  assert.deepEqual(res, { seeded: true });
  assert.deepEqual(readFileSync(f.binary), BUNDLED);
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).sha256, sha(BUNDLED));
});

test("a verified.json for another version does not count", async () => {
  const f = fixture();
  mkdirSync(f.versionDir, { recursive: true });
  writeFileSync(f.binary, "old\n");
  writeFileSync(f.record, JSON.stringify({ version: "0.0.1", sha256: "b".repeat(64) }) + "\n");
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources });
  assert.deepEqual(res, { seeded: true });
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).version, BUNDLED_CORE_VERSION);
});

test("no bundled binary: nothing is written and it says why", async () => {
  const f = fixture({ bundled: false });
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources });
  assert.equal(res.seeded, false);
  assert.match(res.reason, /no bundled Core/);
  assert.equal(existsSync(join(f.dataDir, "core")), false);
});
