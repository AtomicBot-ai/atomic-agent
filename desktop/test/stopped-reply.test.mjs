// ATO-2005 (GitHub #828): only the loop guard's canned stop collapses into the
// yellow warning row. A real answer the model writes after the stop (ATO-2004
// gives it that last step) is a normal message, with a dim "Stopped by the
// loop guard" line over it when it still opens with the guard's parenthesis.
// The templates below are the ones src/agent/progress/loop-notices.ts
// formatForcedLoopReply produces. No deps, no build.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/stopped-reply.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const BEST = "Here is my best answer with the information gathered so far \u2014 the task may be incomplete.";
const WANDERING = "(stopped: `os.web.fetch` hit the limit on different arguments within recent tool calls \u2014 12, counting the last call, which was not run). " + BEST;
const REFUSED = "(stopped: `os.fs.list` kept returning the same no-progress outcome, and the same call was refused 4 times in a row, counting this one). I could not make further progress with the repeated tool call. " + BEST;
const NOT_RUN = "(stopped: `os.fs.list` kept returning the same no-progress outcome, and this call was not run). I could not make further progress with the repeated tool call. " + BEST;
const OLD = "(stopped: stuck in a no-progress loop on `os.fs.list` after 5 blocked attempts). I could not make further progress …";
const ANSWER = "From the 11 pages I read:\n\n- The API takes a bearer token.\n- Rate limit is 60 requests a minute.";

const asst = (text, extra = {}) => ({ id: "a1", k: "assistant", text, ...extra });

test("each canned stop template is the warning row", () => {
  assert.equal(R.stoppedSentence(asst(WANDERING)), "Stopped: the agent kept trying variations of the same step. The task may be incomplete.");
  assert.equal(R.stoppedSentence(asst(REFUSED)), "Stopped: the agent kept repeating the same step without getting anywhere (4 tries). The task may be incomplete.");
  assert.equal(R.stoppedSentence(asst(NOT_RUN)), "Stopped: the agent kept repeating the same step without getting anywhere. The task may be incomplete.");
  assert.equal(R.stoppedSentence(asst(OLD)), "Stopped: the agent kept repeating the same step without getting anywhere (5 tries). The task may be incomplete.");
  assert.equal(R.stoppedSentence(asst("  " + WANDERING + "\n")), "Stopped: the agent kept trying variations of the same step. The task may be incomplete.", "surrounding whitespace");
  for (const t of [WANDERING, REFUSED, NOT_RUN, OLD]) assert.equal(R.stoppedNoteHTML(asst(t), esc), "", "the bare stop has no note: the row says it");
});

test("ordinary text is never the warning row", () => {
  for (const t of [ANSWER, "Done.", "", "I stopped: the build kept failing.", "(stopped)", "Note (stopped: `x` hit the limit on different arguments)"]) {
    assert.equal(R.stoppedSentence(asst(t)), "", t);
    assert.equal(R.stoppedNoteHTML(asst(t), esc), "", t);
    assert.equal(R.stoppedReplyBody(asst(t)), t, "drawn unchanged");
  }
  assert.equal(R.stoppedReplyParts(ANSWER), null);
});

test("a real answer after the stop is a message, with the dim note over it", () => {
  for (const head of [WANDERING, REFUSED, NOT_RUN, OLD]) {
    const m = asst(head + "\n\n" + ANSWER);
    assert.equal(R.stoppedSentence(m), "", "not collapsed into the warning row");
    assert.equal(R.stoppedReplyBody(m), ANSWER, "the canned parenthesis and sentences come off");
    const note = R.stoppedNoteHTML(m, esc);
    assert.match(note, />Stopped by the loop guard</);
    assert.match(note, /class="turn tk-stopnote"/);
    assert.ok(note.includes('title="' + esc(head) + '"'), "the canned text stays in the tooltip");
  }
  // The answer may follow the parenthesis directly, without the canned sentences.
  const direct = asst("(stopped: `os.web.fetch` hit the limit on different arguments within recent tool calls \u2014 12, counting the last call, which was not run). " + ANSWER);
  assert.equal(R.stoppedSentence(direct), "");
  assert.equal(R.stoppedReplyBody(direct), ANSWER);
});

test("placeholders and other rows are never a stop", () => {
  assert.equal(R.stoppedSentence(asst(WANDERING, { placeholder: true })), "");
  assert.equal(R.stoppedSentence({ k: "user", text: WANDERING }), "");
  assert.equal(R.stoppedSentence(null), "");
  assert.equal(R.stoppedReplyBody(asst(WANDERING + " " + ANSWER, { placeholder: true })), WANDERING + " " + ANSWER);
});

test("the note escapes the tooltip text", () => {
  const m = asst("(stopped: `a\"<b>` hit the limit on different arguments within recent tool calls). " + ANSWER);
  const note = R.stoppedNoteHTML(m, esc);
  assert.doesNotMatch(note, /<b>/);
  assert.match(note, /&quot;&lt;b&gt;/);
});

test("renderer.js draws the answer through these helpers, loaded before it", () => {
  const renderer = src("../renderer/renderer.js");
  assert.match(renderer, /if \(m\.k === 'assistant' && stoppedSentence\(m\)\) return stoppedRowHTML\(m\);/);
  assert.match(renderer, /workingRowHTML\(m\) \+ stoppedNoteHTML\(m, esc\) \+ '<div class="turn">/);
  assert.match(renderer, /renderProse\(stoppedReplyBody\(m\)\)/);
  assert.doesNotMatch(renderer, /\nfunction stoppedSentence\(/, "one definition, in stopped-reply.js");
  const html = src("../renderer/index.html");
  const at = (s) => html.indexOf(s);
  assert.ok(at('<script src="stopped-reply.js">') >= 0);
  assert.ok(at('<script src="stopped-reply.js">') < at('<script src="renderer.js">'));
  assert.match(src("../renderer/css/chat.css"), /\.tk-stopnote-t\{/);
});
