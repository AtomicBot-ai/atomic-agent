// ATO-2459: My apps versions (main/my-apps-versions.ts), the same layout the
// agent's app.update writes (src/tools/app/app-versions.ts):
// <app>/versions/<n>-<savedAtMs>.html, newest MY_APP_VERSIONS_KEEP kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../out/main/my-apps-store.js");
const V = require("../out/main/my-apps-versions.js");

const fixed = (hex) => () => Buffer.from(hex, "hex");
function tmpRoot() { return join(mkdtempSync(join(tmpdir(), "my-apps-v-")), "apps"); }

test("keeping a page names it <n>-<when it was written>.html and counts up", () => {
  const root = tmpRoot();
  const { app } = A.saveApp(root, { name: "Fx", html: "<p>one</p>" }, Date.now(), fixed("aaaaaa"));
  const dir = A.appDir(root, app.id);
  const at = new Date(Date.UTC(2026, 10, 20, 9, 30));
  utimesSync(join(dir, "index.html"), at, at);
  assert.deepEqual(V.keepCurrentPage(dir), { version: 1, savedAt: at.toISOString(), bytes: 10 });
  assert.deepEqual(readdirSync(join(dir, "versions")), [`1-${at.getTime()}.html`]);
  writeFileSync(join(dir, "index.html"), "<p>two</p>");
  assert.equal(V.keepCurrentPage(dir).version, 2);
  assert.deepEqual(V.listAppVersions(root, app.id).map((v) => v.version), [2, 1]);
  assert.deepEqual(V.listAppVersions(root, "../x"), []);
});

test("a version the agent wrote is listed and restored here", () => {
  const root = tmpRoot();
  const { app } = A.saveApp(root, { name: "Fx", html: "<p>v2</p>" }, Date.now(), fixed("bbbbbb"));
  const dir = A.appDir(root, app.id);
  mkdirSync(join(dir, "versions"));
  writeFileSync(join(dir, "versions", "1-1764000000000.html"), "<p>v1</p>");   // as src/tools/app/app-versions.ts names it
  writeFileSync(join(dir, "versions", "notes.txt"), "not a version");
  assert.deepEqual(V.listAppVersions(root, app.id), [{ version: 1, savedAt: new Date(1764000000000).toISOString(), bytes: 9 }]);
  const r = V.restoreAppVersion(root, app.id, 1, Date.UTC(2026, 10, 28));
  assert.equal(r.ok, true);
  assert.equal(r.kept.version, 2, "the page it replaced is kept, so the restore can be undone");
  assert.equal(r.app.updatedAt, "2026-11-28T00:00:00.000Z");
  assert.equal(r.app.bytes, 9);
  assert.equal(A.readApp(root, app.id).html, "<p>v1</p>");
  assert.equal(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")).bytes, 9);
  assert.equal(V.restoreAppVersion(root, app.id, 2).ok, true);
  assert.equal(A.readApp(root, app.id).html, "<p>v2</p>");
});

test("restore refuses what it cannot do", () => {
  const root = tmpRoot();
  const { app } = A.saveApp(root, { name: "Fx", html: "<p>x</p>" }, Date.now(), fixed("cccccc"));
  assert.deepEqual(V.restoreAppVersion(root, app.id, 4), { ok: false, reason: "no-version" });
  assert.deepEqual(V.restoreAppVersion(root, app.id, "1"), { ok: false, reason: "no-version" });
  assert.deepEqual(V.restoreAppVersion(root, "../etc", 1), { ok: false, reason: "bad-id" });
  assert.deepEqual(V.restoreAppVersion(root, "gone-000000", 1), { ok: false, reason: "not-found" });
});

test("only the newest versions are kept", () => {
  const root = tmpRoot();
  const { app } = A.saveApp(root, { name: "Fx", html: "<p>x</p>" }, Date.now(), fixed("dddddd"));
  const dir = A.appDir(root, app.id);
  for (let i = 0; i < 4; i++) { writeFileSync(join(dir, "index.html"), `<p>${i}</p>`); V.keepCurrentPage(dir, 3); }
  assert.deepEqual(V.listAppVersions(root, app.id).map((v) => v.version), [4, 3, 2]);
  assert.equal(V.MY_APP_VERSIONS_KEEP, 20);
});
