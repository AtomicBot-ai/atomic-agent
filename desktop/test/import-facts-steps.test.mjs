// Unit tests for renderer/import-facts-steps.js (ATO-2740): the facts import's
// per-step titles, the question before × or Skip drops found facts, the error
// words with the raw text behind Details, and the pick buttons per OS.
// Also the sheet itself (renderer/import-facts.js ifactBodyHTML) drawing them.
// No deps, no build. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../renderer/import-facts-steps.js");
const I = require("../renderer/import-facts.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const h = (platform) => ({ esc, ic: () => "", ...(platform ? { platform } : {}) });

const cands = [
  { id: "c0-1", kind: "profile", key: "work_role", value: "Product owner", pinned: false, quote: "I run the product" },
  { id: "c0-2", kind: "note", key: null, value: "Likes tea", pinned: false, quote: "" },
];
const st = (over = {}) => ({
  open: true, stage: "choose", source: "chatgpt", path: "/Users/me/export.zip", afterImport: false,
  info: { ok: true, supported: true, remote: false, cloud: [] },
  cloudOn: false, cloudProvider: "", job: null, ticks: {}, result: null, error: null, errorDetail: null,
  busy: false, stopping: false, asking: false, ...over,
});
const running = (found) => st({ stage: "running", job: { id: "j", state: "extracting", chunksDone: 2, chunksTotal: 5, found, candidates: null, local: true } });
const review = (list = cands) => st({ stage: "review", job: { id: "j", state: "done", candidates: list, failedChunks: 0, local: true }, ticks: I.ifactTicksFor(list) });
const titleOf = (html) => (html.match(/<span class="ttl">([^<]*)<\/span>/) || [])[1];

test("each step has its own title; 'what I learned' only once facts are listed", () => {
  assert.equal(S.ifactStepTitle(st({ stage: "pick", path: "" })), "Choose your ChatGPT export");
  assert.equal(S.ifactStepTitle(st({ stage: "choose" })), "Find facts about you");
  assert.equal(S.ifactStepTitle(running(0)), "Reading your chats");
  assert.equal(S.ifactStepTitle(review()), "Here is what I learned about you");
  assert.equal(S.ifactStepTitle(review([])), "Nothing new found");
  assert.equal(S.ifactStepTitle(st({ stage: "done" })), "Saved to memory");
  assert.equal(S.ifactStepTitle(st({ stage: "error" })), "Could not bring in facts");
  // The sheet draws it (before ATO-2740 every step said "Here is what I learned about you").
  assert.equal(titleOf(I.ifactBodyHTML(st({ stage: "pick", path: "" }), h())), "Choose your ChatGPT export");
  assert.equal(titleOf(I.ifactBodyHTML(running(3), h())), "Reading your chats");
  assert.equal(titleOf(I.ifactBodyHTML(review(), h())), "Here is what I learned about you");
  assert.match(I.ifactBodyHTML(running(3), h()), /aria-label="Reading your chats"/);
});

test("closing asks first while reading, and while found facts wait unsaved", () => {
  assert.equal(S.ifactCloseNeedsAsk(running(0)), true, "reading is in progress");
  assert.equal(S.ifactCloseNeedsAsk(running(4)), true);
  assert.equal(S.ifactCloseNeedsAsk(review()), true, "Skip would drop the listed facts");
  assert.equal(S.ifactCloseNeedsAsk(review([])), false, "nothing found, nothing to lose");
  assert.equal(S.ifactCloseNeedsAsk(st({ stage: "pick" })), false);
  assert.equal(S.ifactCloseNeedsAsk(st({ stage: "choose" })), false);
  assert.equal(S.ifactCloseNeedsAsk(st({ stage: "done" })), false);
  assert.equal(S.ifactCloseNeedsAsk(st({ stage: "error", job: { id: "j", state: "failed" } })), false);
  assert.equal(S.ifactCloseNeedsAsk({ ...running(2), job: { id: "j", state: "stopped" } }), false, "the run already ended");
  assert.equal(S.ifactCloseNeedsAsk({ ...running(2), open: false }), false);
});

test("the question while reading: N found so far will be lost; Keep importing is the default", () => {
  const ask = S.ifactCloseAsk(running(3), 0);
  assert.equal(ask.title, "Stop importing?");
  assert.match(ask.text, /^3 facts found so far will be lost\./);
  assert.equal(ask.keep, "Keep importing");
  assert.deepEqual(ask.actions.map((a) => a.act), ["ask:discard", "ask:review"], "Stop and review keeps what was found");
  assert.match(S.ifactCloseAsk(running(1), 0).text, /^1 fact found/);
  const none = S.ifactCloseAsk(running(0), 0);
  assert.deepEqual(none.actions.map((a) => a.act), ["ask:discard"], "nothing found yet: no review to offer");
  assert.equal(S.ifactCloseAsk(st({ stage: "choose" }), 0), null);
  const { foot } = S.ifactCloseAskHTML(ask, esc);
  assert.ok(foot.indexOf('data-ifact="ask:keep"') > foot.indexOf('data-ifact="ask:discard"'), "the default sits last, on the right");
  assert.match(foot, /class="btn btn-p sm" type="button" data-ifact="ask:keep">Keep importing</);
});

test("the question on the list: Discard, Save the ticked ones, or Keep reviewing", () => {
  const ask = S.ifactCloseAsk(review(), 2);
  assert.equal(ask.title, "Close without saving?");
  assert.match(ask.text, /^2 facts found will be lost/);
  assert.deepEqual(ask.actions, [{ act: "ask:discard", label: "Discard" }, { act: "ask:save", label: "Save 2" }]);
  assert.deepEqual(S.ifactCloseAsk(review(), 0).actions.map((a) => a.act), ["ask:discard"], "nothing ticked: no Save");
});

test("the sheet shows the question in place of the step while asking", () => {
  const html = I.ifactBodyHTML({ ...running(3), asking: true }, h());
  assert.equal(titleOf(html), "Stop importing?");
  assert.match(html, /3 facts found so far will be lost/);
  assert.doesNotMatch(html, /data-ifact="stop"/, "the step's own buttons are replaced");
  const list = I.ifactBodyHTML({ ...review(), asking: true }, h());
  assert.match(list, />Save 2</);
  assert.doesNotMatch(list, /data-ifact-tick=/);
  // A stale flag with nothing to lose draws the step as usual.
  assert.equal(titleOf(I.ifactBodyHTML({ ...st({ stage: "choose" }), asking: true }, h())), "Find facts about you");
});

test("× and Skip go through the question: ifactClose asks instead of dropping the run", () => {
  const code = src("../renderer/import-facts.js");
  assert.match(code, /if \(!force && IFS\.ifactCloseNeedsAsk\(IFACT\)\) \{ IFACT\.asking = true; ifactPaint\(\); return; \}/);
  assert.match(code, /act === 'ask:discard'\) void ifactClose\(true\)/);
  assert.match(code, /act === 'ask:review'\) \{ IFACT\.asking = false; void ifactStop\(\); \}/);
  const html = src("../renderer/index.html");
  const at = (s) => html.indexOf(s);
  assert.ok(at('<script src="import-facts-steps.js">') >= 0);
  assert.ok(at('<script src="import-facts-steps.js">') < at('<script src="import-facts.js">'), "loaded first: import-facts.js reads it at load");
});

test("errors read as plain words; the raw text sits behind Details", () => {
  const thrown = S.ifactErrorView("Error invoking remote method 'importFacts:start': Error: connect ECONNREFUSED 127.0.0.1:5123", "start", true);
  assert.equal(thrown.text, "Could not reach the agent. Check that it is running, then try again.");
  assert.match(thrown.detail, /ECONNREFUSED/);
  const job = S.ifactErrorView("the model did not answer for any part of the chats", "job", true);
  assert.match(job.text, /^The model did not answer for any part of your chats\./);
  assert.equal(job.detail, "the model did not answer for any part of the chats");
  const unknownJob = S.ifactErrorView("TypeError: Cannot read properties of undefined (reading 'mapping')", "job", true);
  assert.equal(unknownJob.text, S.IFACT_ERROR_FALLBACK.job);
  assert.match(unknownJob.detail, /TypeError/);
  const http = S.ifactErrorView("The agent answered HTTP 500.", "save");
  assert.equal(http.text, S.IFACT_ERROR_FALLBACK.save);
  assert.equal(http.detail, "The agent answered HTTP 500.");
  const read = S.ifactErrorView("The agent could not read that: end of central directory not found", "start");
  assert.match(read.text, /could not be opened as a data export/);
  // Main's own plain words pass through, with no Details.
  const plain = S.ifactErrorView("The agent is already reading an export. Wait for it to finish, or stop it.", "start");
  assert.deepEqual(plain, { text: "The agent is already reading an export. Wait for it to finish, or stop it.", detail: "" });
  assert.deepEqual(S.ifactErrorView("", "stop"), { text: S.IFACT_ERROR_FALLBACK.stop, detail: "" });
  for (const v of [thrown, job, unknownJob, http, read]) assert.doesNotMatch(v.text, /ECONN|HTTP|Error\b|central directory/);
});

test("the sheet draws the plain error and Details only while that same error stands", () => {
  const v = S.ifactErrorView("Error invoking remote method 'importFacts:save': Error: boom", "save", true);
  const on = st({ stage: "review", job: { id: "j", state: "done", candidates: cands }, ticks: I.ifactTicksFor(cands), error: v.text, errorDetail: { for: v.text, text: v.detail } });
  const html = I.ifactBodyHTML(on, h());
  assert.match(html, /role="alert">Could not save the facts you picked\. Try again\.</);
  assert.match(html, /<details class="ifact-errmore"><summary>Details<\/summary><pre>Error invoking remote method/);
  const other = I.ifactBodyHTML({ ...on, error: "Something else." }, h());
  assert.doesNotMatch(other, /ifact-errmore/, "a newer error does not carry the old detail");
  const failed = I.ifactBodyHTML(st({ stage: "error", error: "Reading stopped because of a problem.", errorDetail: { for: "Reading stopped because of a problem.", text: "ENOMEM" } }), h());
  assert.match(failed, /<pre>ENOMEM<\/pre>/);
  const code = src("../renderer/import-facts.js");
  assert.doesNotMatch(code, /'Reading stopped: ' \+ job\.error/, "the agent's raw job error is no longer glued onto the line");
});

test("Windows and Linux get Choose ZIP file and Choose folder; macOS keeps one Choose", () => {
  for (const platform of ["win32", "linux"]) {
    const html = I.ifactBodyHTML(st({ stage: "pick", path: "" }), h(platform));
    assert.match(html, /data-ifact="pick:file">Choose ZIP file</, platform);
    assert.match(html, /data-ifact="pick:folder">Choose folder</, platform);
    assert.doesNotMatch(html, /data-ifact="pick"/, platform);
  }
  const mac = I.ifactBodyHTML(st({ stage: "pick", path: "" }), h("darwin"));
  assert.match(mac, /data-ifact="pick">Choose…</);
  assert.doesNotMatch(mac, /pick:folder/);
  assert.match(I.ifactBodyHTML(st({ stage: "pick", path: "" }), h()), /data-ifact="pick">/, "no platform (the demo): macOS as before");
  assert.match(src("../renderer/import-facts.js"), /act === 'pick:file' \|\| act === 'pick:folder'\) void ifactPick\(act\.slice\(5\)\)/);
  assert.match(src("../preload/preload.ts"), /ipcRenderer\.invoke\("importFacts:pick", source, kind\)/);
});

test("Try again clears the question and the old detail", () => {
  const next = I.ifactRetryState(st({ stage: "error", asking: true, errorDetail: { for: "x", text: "y" } }));
  assert.equal(next.asking, false);
  assert.equal(next.errorDetail, null);
});
