// ATO-1596 / ATO-1597: the pure half of renderer/file-mentions.js, aligned with
// the terminal's src/tui/file-mentions (mention-query.ts, mention-block.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/file-mentions.js");
const A = require("../renderer/attachments.js");

/* ---------- the `@` under the caret ---------- */

test("an @ at the start of the box opens with what follows it", () => {
  assert.deepEqual(R.fmActiveMention("@rea"), { start: 0, end: 4, query: "rea" });
  assert.deepEqual(R.fmActiveMention("@"), { start: 0, end: 1, query: "" });
});

test("an @ after a space opens; one inside a word (an e-mail) does not", () => {
  assert.deepEqual(R.fmActiveMention("look at @src/ap"), { start: 8, end: 15, query: "src/ap" });
  assert.deepEqual(R.fmActiveMention("line\n@rea"), { start: 5, end: 9, query: "rea" });
  assert.equal(R.fmActiveMention("me@site.com"), null);
  assert.equal(R.fmActiveMention("write to me@si"), null);
});

test("the token closes at a space, and the caret decides which one counts", () => {
  assert.equal(R.fmActiveMention("@src/app.ts "), null);
  // caret in the middle of `@readme`: the query is up to the caret, the token runs on
  assert.deepEqual(R.fmActiveMention("see @readme now", 7), { start: 4, end: 11, query: "re" });
  assert.equal(R.fmActiveMention("see @readme now", 2), null);
});

/* ---------- picking a path ---------- */

test("a pick puts `@path ` in place of the token and the caret after the space", () => {
  const text = "fix @ap";
  const r = R.fmInsertPath(text, R.fmActiveMention(text), "src/app.ts");
  assert.equal(r.text, "fix @src/app.ts ");
  assert.equal(r.caret, r.text.length);
});

test("a pick in the middle of a sentence keeps one space and the rest of the text", () => {
  const text = "read @re and tell me";
  const r = R.fmInsertPath(text, R.fmActiveMention(text, 8), "README.md");
  assert.equal(r.text, "read @README.md and tell me");
  assert.equal(r.text.slice(0, r.caret), "read @README.md ");
});

/* ---------- the block a sent message carries ---------- */

const SEP = "\n\n<mentioned-files>\nFiles the user referenced with @, read from the working directory:\n";
const message = "explain @src/app.ts and @big.log" + SEP
  + "- src/app.ts (4 KB)\n"
  + "- big.log (2.0 MB, truncated to the first 256 KB)\n"
  + "- logo.png (12 KB, not inlined: binary)\n"
  + '\n<file path="src/app.ts">\nexport const x = 1;\n</file>\n'
  + '\n<file path="big.log">\nline\n</file>\n[truncated: showing the first 256 KB of 2.0 MB; read the file itself for the rest]\n'
  + "</mentioned-files>";

test("the separator is the terminal's, byte for byte", () => {
  assert.equal(R.FM_SEPARATOR, SEP);
});

test("the block parses into one entry per file, with its size and any cut", () => {
  const s = R.fmSplitBlock(message);
  assert.equal(s.typed, "explain @src/app.ts and @big.log");
  assert.deepEqual(s.files, [
    { path: "src/app.ts", size: "4 KB", note: "" },
    { path: "big.log", size: "2.0 MB", note: "truncated" },
    { path: "logo.png", size: "12 KB", note: "binary", skipped: true },
  ]);
});

test("the bubble collapses to the typed text and a line per file", () => {
  assert.equal(R.fmCollapse(message), [
    "explain @src/app.ts and @big.log",
    "@src/app.ts · 4 KB",
    "@big.log · 2.0 MB · truncated",
    "@logo.png · 12 KB · skipped: binary",
  ].join("\n"));
  const html = R.fmSentHTML(R.fmSplitBlock(message).files);
  assert.equal((html.match(/class="usrcap/g) || []).length, 3);
  assert.ok(!html.includes("export const x"));
});

test("a message without the block, or with a look-alike, is left as typed", () => {
  assert.equal(R.fmSplitBlock("just text"), null);
  assert.equal(R.fmSplitBlock("<mentioned-files> typed by hand"), null);
  assert.equal(R.fmCollapse("just text"), "just text");
  assert.equal(R.fmTypedText("just text"), "just text");
});

/* ---------- send again / rollback take the typed text only ---------- */

test("edit and send again get the typed text without the block", () => {
  assert.equal(R.fmTypedText(message), "explain @src/app.ts and @big.log");
});

test("the attachments block in front of the mention block still parses", () => {
  globalThis.fmTypedText = R.fmTypedText;   // what index.html gives attachments.js
  try {
    const withFiles = A.attBuildMessage("look @src/app.ts",
      [{ path: "/u/.atomic-agent/inbox/desktop/2026-11-18/101500-shot.png", mimeType: "image/png", bytes: 2048 }]);
    const full = withFiles + SEP + "- src/app.ts (4 KB)\n" + '\n<file path="src/app.ts">\nx\n</file>\n' + "</mentioned-files>";
    const split = A.attSplitMessage(full);
    assert.ok(split);
    assert.equal(split.caption, "look @src/app.ts");
    assert.equal(split.items.length, 1);
    assert.equal(A.attPlainText(message), "explain @src/app.ts and @big.log");
    assert.equal(A.attQueueLabel(message), "explain @src/app.ts and @big.log");
  } finally {
    delete globalThis.fmTypedText;
  }
});
