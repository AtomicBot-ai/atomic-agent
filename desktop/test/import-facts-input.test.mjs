// Unit tests for main/import-facts-input.ts (ATO-1656): the full check of the
// window's importFacts:start payload, against the built output.
// Run: npm run build && npm run test:unit
//
// Before this the handler checked only that the path was absolute, so any
// absolute path on the disk could be fed to the importer. Now the shape, the
// source, the path on disk (a real .zip under the cap, or the export folder)
// and the cloud choice (provider plus a literal boolean true) are each
// checked, and the agent is not asked otherwise.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const N = require("../out/main/import-facts-input.js");
const F = require("../out/main/import-facts.js");
const T = N.FACTS_INPUT_TEXT;

const dir = mkdtempSync(join(tmpdir(), "ifact-input-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const zip = join(dir, "data-2026-11-27.zip");
const upper = join(dir, "EXPORT.ZIP");
const txt = join(dir, "notes.txt");
const emptyZip = join(dir, "empty.zip");
const folder = join(dir, "unpacked");
const missing = join(dir, "gone.zip");
writeFileSync(zip, Buffer.from("PK\u0003\u0004 not really a zip, the agent checks that"));
writeFileSync(upper, Buffer.from("PK"));
writeFileSync(txt, "hello");
writeFileSync(emptyZip, "");
mkdirSync(folder);
writeFileSync(join(folder, "conversations.json"), "[]");

const fakeStat = (over = {}) => () => ({ isFile: () => true, isDirectory: () => false, size: 1024, ...over });

test("the checker imports nothing from electron", () => {
  const src = readFileSync(new URL("../main/import-facts-input.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "electron"/);
  assert.doesNotMatch(src, /require\("electron"\)/);
});

test("the export path must be a real .zip or a folder; anything else is refused with words", () => {
  assert.deepEqual(N.checkFactsExportPath(zip), { ok: true, path: zip });
  assert.deepEqual(N.checkFactsExportPath("  " + zip + "  "), { ok: true, path: zip }, "trimmed");
  assert.deepEqual(N.checkFactsExportPath(upper), { ok: true, path: upper }, "the extension is read in any case");
  assert.deepEqual(N.checkFactsExportPath(folder), { ok: true, path: folder }, "the unpacked export");
  assert.deepEqual(N.checkFactsExportPath(txt), { ok: false, error: T.notZip }, "an absolute path is no longer enough");
  assert.deepEqual(N.checkFactsExportPath(emptyZip), { ok: false, error: T.empty });
  assert.deepEqual(N.checkFactsExportPath(missing), { ok: false, error: T.missing });
  for (const bad of ["", "   ", "export.zip", "./export.zip", 42, null, undefined, { path: zip }, zip + "\u0000", "/" + "a".repeat(5000) + ".zip"]) {
    assert.deepEqual(N.checkFactsExportPath(bad), { ok: false, error: T.path }, JSON.stringify(bad).slice(0, 40));
  }
});

test("a .zip over the cap and a path that is neither file nor folder are refused", () => {
  assert.equal(N.FACTS_EXPORT_MAX_BYTES, 2 * 1024 * 1024 * 1024);
  const over = N.checkFactsExportPath("/Users/me/big.zip", fakeStat({ size: 2.5 * 1024 * 1024 * 1024 }));
  assert.equal(over.ok, false);
  assert.match(over.error, /is 2\.5 GB; the agent can read a \.zip up to 2\.0 GB/);
  assert.match(over.error, /choose the folder/);
  assert.equal(N.checkFactsExportPath("/Users/me/big.zip", fakeStat({ size: N.FACTS_EXPORT_MAX_BYTES + 1 })).ok, false, "one byte over");
  assert.equal(N.checkFactsExportPath("/Users/me/ok.zip", fakeStat({ size: N.FACTS_EXPORT_MAX_BYTES })).ok, true, "at the cap is fine");
  assert.deepEqual(N.checkFactsExportPath("/dev/null-ish", fakeStat({ isFile: () => false })), { ok: false, error: T.kind });
  assert.equal(N.factsSizeWords(3 * 1024 * 1024 * 1024), "3.0 GB");
  assert.equal(N.factsSizeWords(5 * 1024 * 1024), "5 MB");
});

test("the cloud part: absent reads locally, an object needs a provider and a boolean true consent", () => {
  for (const none of [undefined, null, false]) assert.deepEqual(N.checkFactsCloud(none), { ok: true, cloud: null });
  assert.deepEqual(N.checkFactsCloud({ provider: " openrouter ", consent: true }), { ok: true, cloud: { provider: "openrouter" } });
  assert.deepEqual(N.checkFactsCloud(true), { ok: false, error: T.provider }, "a bare true names no model");
  assert.deepEqual(N.checkFactsCloud({ consent: true }), { ok: false, error: T.provider });
  assert.deepEqual(N.checkFactsCloud({ provider: "", consent: true }), { ok: false, error: T.provider });
  assert.deepEqual(N.checkFactsCloud({ provider: "openrouter", consent: false }), { ok: false, error: T.consent });
  for (const notBool of ["true", 1, "yes", null, undefined, {}]) {
    assert.deepEqual(N.checkFactsCloud({ provider: "openrouter", consent: notBool }), { ok: false, error: T.notValid }, "consent " + String(notBool));
  }
  for (const shape of ["openrouter", 1, [], ["openrouter"], { provider: "openrouter", consent: true, extra: 1 }]) {
    assert.deepEqual(N.checkFactsCloud(shape), { ok: false, error: T.notValid }, JSON.stringify(shape));
  }
  assert.equal(N.checkFactsCloud({ provider: "a".repeat(121), consent: true }).ok, false, "too long an id");
  assert.equal(N.checkFactsCloud({ provider: "open\nrouter", consent: true }).ok, false, "control characters");
});

test("the whole payload: a plain object with only source, path and cloud", () => {
  assert.deepEqual(N.checkFactsStartInput({ source: "chatgpt", path: zip }), { ok: true, input: { source: "chatgpt", path: zip, cloud: null } });
  assert.deepEqual(N.checkFactsStartInput({ source: "claude", path: folder, cloud: { provider: "anthropic", consent: true } }),
    { ok: true, input: { source: "claude", path: folder, cloud: { provider: "anthropic" } } });
  for (const bad of [null, undefined, "start", 7, [], [{ source: "claude", path: zip }], { source: "claude", path: zip, engine: { kind: "cloud" } }]) {
    assert.deepEqual(N.checkFactsStartInput(bad), { ok: false, error: T.notValid }, JSON.stringify(bad));
  }
  assert.deepEqual(N.checkFactsStartInput({ path: zip }), { ok: false, error: T.source });
  assert.deepEqual(N.checkFactsStartInput({ source: "gemini", path: zip }), { ok: false, error: T.source });
  assert.deepEqual(N.checkFactsStartInput({ source: "claude", path: txt }), { ok: false, error: T.notZip });
  assert.deepEqual(N.checkFactsStartInput({ source: "claude", path: zip, cloud: { provider: "x", consent: "true" } }), { ok: false, error: T.notValid });
});

test("the start body carries the checked path and the cloud engine only with the tick", () => {
  assert.deepEqual(F.factsStartBody({ source: "claude", path: " " + zip }),
    { ok: true, local: true, body: { source: "claude", path: zip, engine: { kind: "local" } } });
  const cloud = F.factsStartBody({ source: "chatgpt", path: folder, cloud: { provider: "openrouter", consent: true } });
  assert.deepEqual(cloud, { ok: true, local: false, body: { source: "chatgpt", path: folder, engine: { kind: "cloud", provider: "openrouter", cloudConsent: true } } });
  assert.deepEqual(F.factsStartBody({ source: "claude", path: txt }), { ok: false, error: T.notZip });
});

test("the start handler refuses a bad payload before the agent is asked, and sends a good one", async () => {
  const calls = [];
  const client = {
    status: { state: "connected" },
    isRemote: false,
    capabilities: async () => ({ agent: { importFacts: true } }),
    config: async () => ({}),
    importFactsRoute: async (method, path, body) => {
      calls.push({ method, path, body });
      return { status: 200, body: { job: { id: "job-1", source: "claude", state: "reading", providerId: "local", local: true, progress: {}, candidates: null, error: null } } };
    },
  };
  const h = F.createImportFactsHandlers({ client });   // the real file system, as import-facts-ipc.ts wires it
  assert.deepEqual(await h.start({ source: "claude", path: txt }), { ok: false, error: T.notZip });
  assert.deepEqual(await h.start({ source: "claude", path: missing }), { ok: false, error: T.missing });
  assert.deepEqual(await h.start({ source: "claude", path: zip, cloud: "openrouter" }), { ok: false, error: T.notValid });
  assert.deepEqual(await h.start(["claude", zip]), { ok: false, error: T.notValid });
  assert.deepEqual(calls, [], "nothing reached the agent");
  const ok = await h.start({ source: "claude", path: zip });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [{ method: "POST", path: "start", body: { source: "claude", path: zip, engine: { kind: "local" } } }]);
});
