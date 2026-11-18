// Unit tests for renderer/import-facts.js (ATO-1629 / ATO-1061): the
// "Here is what I learned about you" step's pure helpers and its screens.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const I = createRequire(import.meta.url)("../renderer/import-facts.js");
const h = { esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]), ic: () => "" };

const cands = [
  { id: "c0-1", kind: "profile", key: "work_role", value: "Product owner", pinned: false, quote: "I run the product" },
  { id: "c0-2", kind: "note", key: null, value: "Likes <b>tea</b>", pinned: false, quote: "" },
  { id: "c1-1", kind: "profile", key: "home.city", value: "Tallinn", pinned: true, quote: "here in Tallinn" },
];
const st = (over = {}) => ({
  open: true, stage: "choose", source: "claude", path: "/Users/me/export.zip", afterImport: true,
  info: { ok: true, supported: true, remote: false, cloud: [{ id: "openrouter", label: "OpenRouter" }] },
  cloudOn: false, cloudProvider: "openrouter", job: null, ticks: {}, result: null, error: null, busy: false, stopping: false, ...over,
});

test("the step shows only on an agent whose capabilities list importFacts", () => {
  assert.equal(I.ifactSupported({ agent: { importFacts: true } }), true);
  assert.equal(I.ifactSupported({ agent: { questions: true } }), false);
  assert.equal(I.ifactSupported(null), false);
  assert.equal(I.ifactEntryHTML({ agent: {} }, "settings"), "");
  assert.match(I.ifactEntryHTML({ agent: { importFacts: true } }, "settings"), /data-ifact="open:chatgpt"/);
});

test("progress reads Reading part N of M, never past M", () => {
  assert.equal(I.ifactProgressLine({ state: "reading" }), "Opening your export…");
  assert.equal(I.ifactProgressLine({ state: "extracting", chunksDone: 0, chunksTotal: 0 }), "Reading your chats…");
  assert.equal(I.ifactProgressLine({ state: "extracting", chunksDone: 0, chunksTotal: 12 }), "Reading part 1 of 12");
  assert.equal(I.ifactProgressLine({ state: "extracting", chunksDone: 12, chunksTotal: 12 }), "Reading part 12 of 12");
  assert.equal(I.ifactProgressPct({ chunksDone: 3, chunksTotal: 12 }), 25);
  assert.equal(I.ifactProgressPct(null), 0);
});

test("a job's state picks its screen", () => {
  assert.equal(I.ifactStageFor({ state: "reading" }), "running");
  assert.equal(I.ifactStageFor({ state: "extracting" }), "running");
  assert.equal(I.ifactStageFor({ state: "done" }), "review");
  assert.equal(I.ifactStageFor({ state: "stopped" }), "review");
  assert.equal(I.ifactStageFor({ state: "failed" }), "error");
});

test("every fact starts ticked; ticks toggle and the approved ids follow the list", () => {
  const t = I.ifactTicksFor(cands);
  assert.deepEqual(I.ifactApproved(cands, t), ["c0-1", "c0-2", "c1-1"]);
  const off = I.ifactToggle(t, "c0-2");
  assert.equal(t["c0-2"], true, "the old ticks are not changed");
  assert.deepEqual(I.ifactApproved(cands, off), ["c0-1", "c1-1"]);
  assert.deepEqual(I.ifactApproved(cands, I.ifactSetAll(cands, false)), []);
  assert.deepEqual(I.ifactApproved(cands, I.ifactSetAll(cands, true)).length, 3);
  assert.deepEqual(I.ifactApproved(null, t), []);
});

test("the result line says saved and skipped as already known", () => {
  assert.equal(I.ifactResultLine({ saved: 4, skipped: 2, conflicts: 0, failed: 0 }), "Saved 4, skipped 2 (already known).");
  assert.match(I.ifactResultLine({ saved: 1, skipped: 0, conflicts: 2, failed: 1 }), /2 left as they were.*1 could not be saved/);
  assert.equal(I.ifactResultLine(null), "");
});

test("the job is polled only while the step is open, running and the window can be seen", () => {
  const running = st({ stage: "running", job: { id: "j", state: "extracting" } });
  assert.equal(I.ifactShouldPoll(running, false), true);
  assert.equal(I.ifactShouldPoll(running, true), false, "window hidden");
  assert.equal(I.ifactShouldPoll({ ...running, open: false }, false), false, "step closed");
  assert.equal(I.ifactShouldPoll({ ...running, stage: "review" }, false), false);
  assert.equal(I.ifactShouldPoll({ ...running, job: { id: "j", state: "done" } }, false), false);
  assert.equal(I.IFACT_POLL_MS, 500);
});

test("start sends the cloud model only with this run's tick", () => {
  assert.deepEqual(I.ifactStartInput(st()), { source: "claude", path: "/Users/me/export.zip" });
  assert.deepEqual(I.ifactStartInput(st({ cloudOn: true })), {
    source: "claude", path: "/Users/me/export.zip", cloud: { provider: "openrouter", consent: true },
  });
  assert.deepEqual(I.ifactStartInput(st({ cloudOn: true, cloudProvider: "" })), { source: "claude", path: "/Users/me/export.zip" });
});

test("the model screen: local by default, the cloud box carries the warning and names the provider", () => {
  const html = I.ifactBodyHTML(st(), h);
  assert.match(html, /local model reads your chats/);
  assert.ok(html.includes(I.IFACT_CLOUD_WARNING));
  assert.doesNotMatch(html, /data-ifact-field="cloud" checked/, "the box starts unticked");
  const cloud = I.ifactBodyHTML(st({ cloudOn: true }), h);
  assert.match(cloud, /Provider: <b>OpenRouter<\/b>/);
  assert.match(cloud, /OpenRouter reads your chats in the cloud/);
  const none = I.ifactBodyHTML(st({ info: { ok: true, supported: true, remote: false, cloud: [] } }), h);
  assert.doesNotMatch(none, /data-ifact-field="cloud"/, "no cloud model set up, no box");
});

test("the ChatGPT screen asks for the export and says how to get it", () => {
  const html = I.ifactBodyHTML(st({ stage: "pick", source: "chatgpt", path: "" }), h);
  assert.ok(html.includes(I.IFACT_CHATGPT_HINT.replace(/"/g, "&quot;")));
  assert.match(html, /Data controls/);
  assert.match(html, /data-ifact="next" disabled/);
});

test("the running screen has the progress and Stop", () => {
  const html = I.ifactBodyHTML(st({ stage: "running", job: { id: "j", state: "extracting", chunksDone: 1, chunksTotal: 4, local: true } }), h);
  assert.match(html, /Reading part 2 of 4/);
  assert.match(html, /data-ifact="stop"/);
});

test("the list: each fact with its quote and tick, text escaped, Save counts the ticks", () => {
  const job = { id: "j", state: "done", candidates: cands, failedChunks: 0, local: true };
  const ticks = I.ifactToggle(I.ifactTicksFor(cands), "c1-1");
  const html = I.ifactBodyHTML(st({ stage: "review", job, ticks }), h);
  assert.equal((html.match(/data-ifact-tick=/g) || []).length, 3);
  assert.equal((html.match(/data-ifact-tick="[^"]+" checked/g) || []).length, 2);
  assert.match(html, /“I run the product”/);
  assert.match(html, /Work role/);
  assert.match(html, /Likes &lt;b&gt;tea&lt;\/b&gt;/);
  assert.match(html, />Save 2</);
  const none = I.ifactBodyHTML(st({ stage: "review", job, ticks: I.ifactSetAll(cands, false) }), h);
  assert.match(none, /data-ifact="save" disabled/);
  const empty = I.ifactBodyHTML(st({ stage: "review", job: { ...job, candidates: [] }, ticks: {} }), h);
  assert.match(empty, /Nothing new about you/);
  const stopped = I.ifactBodyHTML(st({ stage: "review", job: { ...job, state: "stopped" }, ticks: I.ifactTicksFor(cands) }), h);
  assert.match(stopped, /Stopped early/);
});

test("profile keys read as words", () => {
  assert.equal(I.ifactKeyWords("work_role"), "Work role");
  assert.equal(I.ifactKeyWords("home.city"), "Home city");
  assert.equal(I.ifactKeyWords(""), "");
});
