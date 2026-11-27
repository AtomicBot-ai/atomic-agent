// ATO-2514: Settings, Meetings (main/meeting-prefs.ts): the folder, the call's
// sound and speakers by voice, kept in userData/meetings.json.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/meeting-prefs.js");
const dir = mkdtempSync(join(tmpdir(), "mtg-prefs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("defaults: Documents folder, the call's sound on, voices on", () => {
  assert.deepEqual(P.readMeetingPrefs(join(dir, "none")), { folder: null, systemAudio: true, voices: true });
  writeFileSync(join(dir, "meetings.json"), "{not json");
  assert.deepEqual(P.readMeetingPrefs(dir), P.MEETING_PREFS_DEFAULTS);
});

test("a change keeps what is valid; a relative or empty folder is refused, null resets it", () => {
  const abs = join(dir, "Notes");
  let p = P.mergeMeetingPrefs(P.MEETING_PREFS_DEFAULTS, { folder: abs, voices: false, junk: 1 });
  assert.deepEqual(p, { folder: abs, systemAudio: true, voices: false });
  assert.equal(P.mergeMeetingPrefs(p, { folder: "relative/x" }).folder, abs);
  assert.equal(P.mergeMeetingPrefs(p, { folder: "" }).folder, abs);
  assert.equal(P.mergeMeetingPrefs(p, { folder: null }).folder, null);
  assert.equal(P.writeMeetingPrefs(dir, p), true);
  assert.deepEqual(P.readMeetingPrefs(dir), p);
});
