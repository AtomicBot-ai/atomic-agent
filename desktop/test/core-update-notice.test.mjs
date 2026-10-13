// Unit tests for main/core-update-notice.ts, against the built output.
// Run: npm run build && npm run test:unit
// The Atomic Core update toast: never for requiresAgentUpdate (the person
// cannot act on it), and once per version for a real update.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("../out/main/core-update-notice.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const check = (o) => ({ currentVersion: "0.11.2", compatibleVersion: "0.13.6", latestVersion: "0.13.6", updateAvailable: true, requiresAgentUpdate: false, ...o });

test("requiresAgentUpdate alone never toasts", () => {
  assert.equal(N.coreUpdateNoticeVersion(check({ updateAvailable: false, requiresAgentUpdate: true, compatibleVersion: "0.11.2", latestVersion: "0.14.0" }), null), null);
});

test("a real update toasts for the compatible version, even when a newer one needs a newer agent", () => {
  assert.equal(N.coreUpdateNoticeVersion(check(), null), "0.13.6");
  assert.equal(N.coreUpdateNoticeVersion(check({ requiresAgentUpdate: true, latestVersion: "0.14.0" }), null), "0.13.6");
});

test("nothing installed yet, nothing available, or the same version: no toast", () => {
  assert.equal(N.coreUpdateNoticeVersion(check({ currentVersion: null }), null), null);
  assert.equal(N.coreUpdateNoticeVersion(check({ updateAvailable: false }), null), null);
  assert.equal(N.coreUpdateNoticeVersion(check({ currentVersion: "0.13.6" }), null), null);
  assert.equal(N.coreUpdateNoticeVersion(null, null), null);
});

test("a version already shown stays quiet across launches; a newer one toasts again", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-notice-"));
  dirs.push(dir);
  assert.equal(N.readDismissedCoreUpdate(dir), null);
  assert.equal(N.writeDismissedCoreUpdate(dir, "0.13.6"), true);
  assert.equal(N.readDismissedCoreUpdate(dir), "0.13.6");
  assert.equal(N.coreUpdateNoticeVersion(check(), N.readDismissedCoreUpdate(dir)), null);
  assert.equal(N.coreUpdateNoticeVersion(check({ compatibleVersion: "0.14.0" }), N.readDismissedCoreUpdate(dir)), "0.14.0");
});

test("a damaged file reads as nothing dismissed", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-notice-"));
  dirs.push(dir);
  writeFileSync(N.coreUpdateNoticePath(dir), "{not json");
  assert.equal(N.readDismissedCoreUpdate(dir), null);
  writeFileSync(N.coreUpdateNoticePath(dir), JSON.stringify({ dismissed: "../../x" }));
  assert.equal(N.readDismissedCoreUpdate(dir), null);
});
