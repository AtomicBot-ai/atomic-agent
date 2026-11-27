// Settings › My files (ATO-1626): the screen's words and the wiring pins.
// Run: npm run test:unit (the renderer helpers need no build)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { mfPercent, mfProgressText, mfFolderMeta, mfParseAct, mfBase, MF_INTRO, MF_POLL_MS } = require("../renderer/my-files.js");

const st = (over = {}) => ({ running: false, found: 0, indexed: 0, failed: 0, skipped: 0, updatedAt: "", ...over });

test("progress reads 'Indexing 120 of 480 files' while it runs", () => {
  assert.equal(mfProgressText(st({ running: true, found: 480, indexed: 120 })), "Indexing 120 of 480 files");
  assert.equal(mfProgressText(st({ running: true, found: 1, indexed: 0 })), "Indexing 0 of 1 file");
  assert.equal(mfProgressText(st({ running: true, found: 0 })), "Looking for files…");
  // Failed and skipped files are done too: the count does not stall on them.
  assert.equal(mfProgressText(st({ running: true, found: 10, indexed: 5, failed: 2, skipped: 1 })), "Indexing 8 of 10 files");
});

test("progress when idle: what got indexed and what did not", () => {
  assert.equal(mfProgressText(st({ found: 480, indexed: 480 })), "480 files indexed");
  assert.equal(mfProgressText(st({ found: 10, indexed: 7, failed: 2, skipped: 1 })), "7 files indexed · 2 could not be read · 1 skipped");
  assert.equal(mfProgressText(st()), "", "nothing found yet: no line");
  assert.equal(mfProgressText(null), "");
});

test("the bar's percent is bounded and null before anything is found", () => {
  assert.equal(mfPercent(st({ found: 480, indexed: 120 })), 25);
  assert.equal(mfPercent(st({ found: 3, indexed: 9 })), 100);
  assert.equal(mfPercent(st({ found: 0 })), null);
  assert.equal(mfPercent(null), null);
});

test("a folder row's count", () => {
  assert.equal(mfFolderMeta({ fileCount: 40, indexedCount: 12 }), "12 of 40 files");
  assert.equal(mfFolderMeta({ fileCount: 40, indexedCount: 40 }), "40 files");
  assert.equal(mfFolderMeta({ fileCount: 1, indexedCount: 1 }), "1 file");
  assert.equal(mfFolderMeta({ fileCount: 0, indexedCount: 0 }), "0 files");
});

test("acts carry a row index, never a path", () => {
  assert.deepEqual(mfParseAct("remove:3"), { verb: "remove", index: 3 });
  assert.deepEqual(mfParseAct("removeConfirm:0"), { verb: "removeConfirm", index: 0 });
  assert.deepEqual(mfParseAct("add"), { verb: "add", index: null });
  assert.deepEqual(mfParseAct("remove:/Users/me"), { verb: "remove", index: null });
  assert.deepEqual(mfParseAct("remove:-1"), { verb: "remove", index: null });
});

test("basename of posix and Windows paths", () => {
  assert.equal(mfBase("/Users/me/Docs/report.pdf"), "report.pdf");
  assert.equal(mfBase("C:\\Users\\me\\Docs\\"), "Docs");
});

test("the intro is one sentence and avoids the words we do not use", () => {
  assert.equal((MF_INTRO.match(/\.(\s|$)/g) || []).length, 1);
  assert.doesNotMatch(MF_INTRO, /nothing leaves your machine/i);
  assert.ok(MF_POLL_MS >= 2000 && MF_POLL_MS <= 5000, "a few seconds");
});

test("the poll stops itself when the pane is not shown", () => {
  const src = readFileSync(new URL("../renderer/my-files.js", import.meta.url), "utf8");
  assert.match(src, /function mfTick\(\) \{\n  if \(!mfVisible\(\)\) \{ mfStopPoll\(\); return; \}/);
  assert.match(src, /settingsPaneId\(S\.settingsPane\) === 'myfiles'/);
});

test("the screen is wired: section, pane, entry, acts, styles, analytics", () => {
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /\['memory','Memory','memory',\['memory'\]\],\n  \['myfiles','My files','folder',\['myfiles'\]\],/);
  assert.match(renderer, /SETTINGS_TABS\.splice\(SETTINGS_TABS\.findIndex\(\(t\) => t\[0\] === 'memory'\) \+ 1, 0, \['myfiles','My files'\]\);/);
  assert.match(renderer, /else if \(pane === 'myfiles'\) myFilesTabEntered\(\);/);
  assert.match(renderer, /if \(p === 'myfiles'\) return myFilesTab\(\);/);
  assert.match(renderer, /if \(k === 'myfiles'\) \{ close\(\); myFilesAct\(a\.slice\(8\)\); return; \}/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="my-files.js"') !== -1 && html.indexOf('src="my-files.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.includes('href="css/my-files.css"'));
  const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");
  assert.match(acts, /myfiles:\{refresh:L, add:L, remove:L, removeConfirm:L, removeCancel:L, ocr:L\}/);
});

test("the stylesheet uses theme tokens only, no fixed colours", () => {
  const css = readFileSync(new URL("../renderer/css/my-files.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
