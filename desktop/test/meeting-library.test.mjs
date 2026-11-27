// ATO-2514: the saved meetings in a folder (main/meeting-library.ts).
// Run: npm run test:unit (needs the build: out/main)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/meeting-library.js");

test("only the recorder's transcripts are listed, newest first, with their notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mtg-lib-"));
  writeFileSync(join(dir, "Meeting 2026-11-27 14-05 transcript.txt"), "a");
  writeFileSync(join(dir, "Meeting 2026-11-28 09-30 transcript.txt"), "bb");
  writeFileSync(join(dir, "Meeting 2026-11-27 14-05 transcript.notes.md"), "notes");
  writeFileSync(join(dir, "shopping.txt"), "x");
  mkdirSync(join(dir, "Meeting 2026-11-29 10-00 transcript.txt"));
  const items = L.listMeetings(dir);
  assert.deepEqual(items.map((i) => i.name), ["Meeting 2026-11-28 09-30 transcript.txt", "Meeting 2026-11-27 14-05 transcript.txt"]);
  assert.equal(items[0].bytes, 2);
  assert.equal(items[0].notes, null);
  assert.equal(items[1].notes, "Meeting 2026-11-27 14-05 transcript.notes.md");
  assert.equal(items[1].startedAt, new Date(2026, 10, 27, 14, 5).getTime());
});

test("a folder that does not exist yet is an empty list", () => {
  assert.deepEqual(L.listMeetings(join(tmpdir(), "no-such-folder-" + Date.now())), []);
});

test("a name from the page reaches only a transcript in the folder", () => {
  assert.equal(L.meetingFilePath("/m", "Meeting 2026-11-27 14-05 transcript.txt"), join("/m", "Meeting 2026-11-27 14-05 transcript.txt"));
  for (const bad of ["../Meeting 2026-11-27 14-05 transcript.txt", "/etc/passwd", "Meeting 2026-11-27 14-05 transcript.txt/../../x", "", 7, null]) {
    assert.equal(L.meetingFilePath("/m", bad), null, String(bad));
  }
  assert.ok(Number.isNaN(L.meetingNameTime("Meeting 2026-02-31 10-00 transcript.txt")));
});
