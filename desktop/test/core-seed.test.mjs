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
const { seedBundledCore, coreBinaryRuns, resetCoreForRedownload } = require("../out/main/core-seed.js");
const { BUNDLED_CORE_VERSION, bundledCoreFileName } = require("../out/main/core-bundle.js");

const WIN = process.platform === "win32";
const NAME = bundledCoreFileName();
const BUNDLED = Buffer.from("bundled core binary, signed\n");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
// The fixture binary is not a program: the probe stands in for `<binary> --version`.
const runs = async () => ({ version: BUNDLED_CORE_VERSION });

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
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: runs });
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
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: runs });
  assert.equal(res.seeded, false);
  assert.match(res.reason, /already installed/);
  assert.deepEqual(readFileSync(f.binary), theirs);
  assert.equal(readFileSync(f.record, "utf8"), record);
});

test("a binary without verified.json is not an install: it is re-seeded", async () => {
  const f = fixture();
  mkdirSync(f.versionDir, { recursive: true });
  writeFileSync(f.binary, "half an install\n");
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: runs });
  assert.deepEqual(res, { seeded: true });
  assert.deepEqual(readFileSync(f.binary), BUNDLED);
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).sha256, sha(BUNDLED));
});

test("a verified.json for another version does not count", async () => {
  const f = fixture();
  mkdirSync(f.versionDir, { recursive: true });
  writeFileSync(f.binary, "old\n");
  writeFileSync(f.record, JSON.stringify({ version: "0.0.1", sha256: "b".repeat(64) }) + "\n");
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: runs });
  assert.deepEqual(res, { seeded: true });
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).version, BUNDLED_CORE_VERSION);
});

test("no bundled binary: nothing is written and it says why", async () => {
  const f = fixture({ bundled: false });
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: runs });
  assert.equal(res.seeded, false);
  assert.match(res.reason, /no bundled Core/);
  assert.equal(existsSync(join(f.dataDir, "core")), false);
});

test("a copy that does not run is not seeded: no verified.json, so the agent downloads Core itself", async () => {
  const f = fixture();
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: async () => ({ error: "spawn EACCES" }) });
  assert.equal(res.seeded, false);
  assert.match(res.reason, /would not run \(spawn EACCES\)/);
  assert.equal(existsSync(f.record), false);
  assert.equal(existsSync(f.binary), false);
  // No staged copy left behind either.
  assert.deepEqual(readdirSync(f.versionDir), []);
});

test("a copy that prints another version is not seeded", async () => {
  const f = fixture();
  const res = await seedBundledCore(f.dataDir, { resourcesPath: f.resources, probe: async () => ({ version: "0.0.1" }) });
  assert.equal(res.seeded, false);
  assert.match(res.reason, /reported version "0\.0\.1"/);
  assert.equal(existsSync(f.record), false);
});

test("the default probe really runs the binary (a script that prints the version)", { skip: WIN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "core-probe-"));
  roots.push(dir);
  const good = join(dir, "good");
  writeFileSync(good, `#!/bin/sh\necho ${BUNDLED_CORE_VERSION}\n`, { mode: 0o755 });
  assert.deepEqual(await coreBinaryRuns(good, BUNDLED_CORE_VERSION), { ok: true });
  const bad = join(dir, "bad");
  writeFileSync(bad, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  assert.equal((await coreBinaryRuns(bad, BUNDLED_CORE_VERSION)).ok, false);
});

test("Download again: verified.json goes, a binary that runs stays, one that does not goes too", async () => {
  const f = fixture();
  mkdirSync(f.versionDir, { recursive: true });
  writeFileSync(f.binary, "seeded\n");
  writeFileSync(f.record, JSON.stringify({ version: BUNDLED_CORE_VERSION, sha256: "c".repeat(64) }) + "\n");
  let res = await resetCoreForRedownload(f.dataDir, { probe: runs });
  assert.equal(res.version, BUNDLED_CORE_VERSION);
  assert.equal(existsSync(f.record), false);
  assert.equal(existsSync(f.binary), true);

  writeFileSync(f.record, JSON.stringify({ version: BUNDLED_CORE_VERSION, sha256: "c".repeat(64) }) + "\n");
  res = await resetCoreForRedownload(f.dataDir, { probe: async () => ({ error: "bad CPU type in executable" }) });
  assert.equal(existsSync(f.record), false);
  assert.equal(existsSync(f.binary), false);
  assert.equal(res.removedBinary, true);
});

test("Download again resets the version active.json names, not only the bundled one", async () => {
  const f = fixture();
  const other = join(f.dataDir, "core", "versions", "0.11.2");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(f.dataDir, "core", "active.json"), JSON.stringify({ version: "0.11.2" }) + "\n");
  writeFileSync(join(other, "verified.json"), "{}\n");
  const res = await resetCoreForRedownload(f.dataDir, { probe: runs });
  assert.equal(res.version, "0.11.2");
  assert.equal(existsSync(join(other, "verified.json")), false);
});
