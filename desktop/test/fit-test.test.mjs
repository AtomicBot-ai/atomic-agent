// ATO-1091: Settings › Models › "Find the best model for my tasks".
// main/fit-test.ts reads what `atag models fit-test --json` (ATO-1090) prints
// (against the built output: npm run build && npm run test:unit);
// renderer/fit-test.js turns it into plain words and the results table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/fit-test.js");
const R = require("../renderer/fit-test.js");

const GB = 1024 ** 3;
const h = { esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]), ic: () => "" };
const nameOf = (m) => ({ "qwen3-8b": "Qwen 3 8B", "gemma4-4b": "Gemma 4 4B", "llama-3b": "Llama 3B" })[m && m.id] || String(m && m.id);
const result = {
  tasks: 10,
  winner: "qwen3-8b",
  models: [
    { id: "gemma4-4b", name: null, accuracy: 0.6, passed: 6, total: 10, avgSeconds: 8, tokensPerSec: 40, peakMemoryBytes: 3.4 * GB, error: null },
    { id: "qwen3-8b", name: null, accuracy: 0.8, passed: 8, total: 10, avgSeconds: 12.4, tokensPerSec: 25, peakMemoryBytes: 5.2 * GB, error: null },
    { id: "llama-3b", name: null, accuracy: null, passed: null, total: null, avgSeconds: null, tokensPerSec: null, peakMemoryBytes: null, error: "ran out of memory" },
  ],
};

/* ---------- main: the contract ---------- */

test("the entry shows only when `atag models --help` lists fit-test", () => {
  assert.equal(M.fitTestListed("Subcommands:\n  list   Show\n  fit-test [--json]   Which local model is best on your tasks\n"), true);
  assert.equal(M.fitTestListed("Subcommands:\n  list   Show\n  recommend [--json]  what fits\n"), false);
  assert.equal(M.fitTestListed(""), false);
});

test("progress lines are read, other lines ignored", () => {
  const p = M.parseFitLine('{"type":"progress","model":"qwen3-8b","modelIndex":2,"models":3,"task":4,"tasks":10,"phase":"running"}');
  assert.equal(p.kind, "progress");
  assert.deepEqual(p.progress, { model: "qwen3-8b", modelIndex: 2, models: 3, task: 4, tasks: 10, phase: "running" });
  assert.equal(M.parseFitLine("Loading model… 45%"), null);
  assert.equal(M.parseFitLine("{not json"), null);
  assert.equal(M.parseFitLine('{"type":"log","text":"x"}'), null);
  assert.equal(M.parseFitLine('{"type":"progress","phase":"warming"}').progress.phase, null);
});

test("the result line becomes the result, with the winner kept only when it is a tested model", () => {
  const line = JSON.stringify({ type: "result", tasks: 10, winner: "qwen3-8b", models: [
    { id: "qwen3-8b", name: "Qwen 3 8B", accuracy: 80, passed: 8, total: 10, avgSeconds: 12.4, peakMemoryBytes: 5e9 },
    { id: "gemma4-4b", passed: 6, total: 10 },
    { name: "no id" },
  ] });
  const r = M.parseFitLine(line).result;
  assert.equal(r.models.length, 2);
  assert.equal(r.winner, "qwen3-8b");
  assert.equal(r.models[0].accuracy, 0.8, "80 means 80%");
  assert.equal(r.models[1].accuracy, 0.6, "from passed / total");
  assert.equal(r.models[1].avgSeconds, null);
  assert.equal(M.readFitResult({ winner: "other", models: [{ id: "a" }] }).winner, null);
  assert.equal(M.readFitResult({ models: [] }), null);
});

test("the result is found in a whole stdout: the last result line, or one JSON document", () => {
  const out = [
    '{"type":"progress","model":"a","modelIndex":1,"models":2}',
    "some log line",
    '{"type":"result","winner":"a","models":[{"id":"a","accuracy":0.5}]}',
    "",
  ].join("\n");
  assert.equal(M.fitResultFromStdout(out).winner, "a");
  const doc = JSON.stringify({ winner: "b", models: [{ id: "b", accuracy: 1 }] }, null, 2);
  assert.equal(M.fitResultFromStdout(doc).winner, "b");
  assert.equal(M.fitResultFromStdout("Error: no tasks yet"), null);
});

test("--models goes with 2 or 3 clean ids, never with one or with junk", () => {
  assert.deepEqual(M.fitModelArgs(["a", "b"]), ["--models", "a,b"]);
  assert.deepEqual(M.fitModelArgs(["a", "b", "c", "d"]), ["--models", "a,b,c"]);
  assert.deepEqual(M.fitModelArgs(["a", "a"]), []);
  assert.deepEqual(M.fitModelArgs(["a", "b;rm -rf"]), []);
  assert.deepEqual(M.fitModelArgs(null), []);
});

/* ---------- renderer: plain words ---------- */

test("accuracy, speed and memory read as plain words", () => {
  assert.equal(R.fitRightWords(result.models[1]), "8 of 10");
  assert.equal(R.fitRightWords({ accuracy: 0.75 }), "75%");
  assert.equal(R.fitRightWords({}), "Not measured");
  assert.equal(R.fitSpeedWords({ avgSeconds: 4.26 }), "4.3 s per task");
  assert.equal(R.fitSpeedWords({ avgSeconds: 12.4 }), "12 s per task");
  assert.equal(R.fitSpeedWords({ avgSeconds: 65 }), "1 min 5 s per task");
  assert.equal(R.fitSpeedWords({ avgSeconds: 120 }), "2 min per task");
  assert.equal(R.fitSpeedWords({ tokensPerSec: 25.4 }), "25 tokens a second");
  assert.equal(R.fitSpeedWords({}), "Not measured");
  assert.equal(R.fitMemoryWords(5.2 * GB), "5.2 GB");
  assert.equal(R.fitMemoryWords(12.4 * GB), "12 GB");
  assert.equal(R.fitMemoryWords(640 * 1024 ** 2), "640 MB");
  assert.equal(R.fitMemoryWords(null), "Not measured");
});

test("ranking: finished first, most right, then faster; the agent's winner is kept", () => {
  assert.deepEqual(R.fitRank(result.models).map((m) => m.id), ["qwen3-8b", "gemma4-4b", "llama-3b"]);
  assert.equal(R.fitWinnerId(result), "qwen3-8b");
  // A winner that did not finish gives way to the best that did.
  assert.equal(R.fitWinnerId({ ...result, winner: "llama-3b" }), "qwen3-8b");
  assert.equal(R.fitWinnerId({ models: [result.models[2]] }), null);
  const tie = [{ id: "slow", accuracy: 0.5, avgSeconds: 20 }, { id: "fast", accuracy: 0.5, avgSeconds: 5 }];
  assert.equal(R.fitRank(tie)[0].id, "fast");
});

test("the summary names the winner in plain words", () => {
  assert.equal(R.fitSummary(result, nameOf, "gemma4-4b"), "Qwen 3 8B did best on your tasks: 8 of 10 right, 12 s per task, 5.2 GB of memory.");
  assert.match(R.fitSummary(result, nameOf, "qwen3-8b"), /It is the model you use now\.$/);
  assert.match(R.fitSummary({ models: [result.models[2]] }, nameOf, null), /No model finished/);
});

test("progress says what runs now, and how far", () => {
  assert.equal(R.fitProgressLine(null, nameOf), "Starting the test…");
  assert.equal(R.fitProgressLine({ model: "qwen3-8b", modelIndex: 2, models: 3, phase: "loading" }, nameOf), "Loading Qwen 3 8B (model 2 of 3)…");
  assert.equal(R.fitProgressLine({ model: "qwen3-8b", modelIndex: 2, models: 3, task: 4, tasks: 10, phase: "running" }, nameOf),
    "Testing Qwen 3 8B (model 2 of 3): task 4 of 10…");
  assert.equal(R.fitProgressLine({ model: "qwen3-8b", phase: "judging" }, nameOf), "Checking the answers of Qwen 3 8B…");
  assert.equal(R.fitProgressFraction({ modelIndex: 2, models: 4, task: 6, tasks: 10 }), 0.375);
  assert.equal(R.fitProgressFraction({ modelIndex: 1, models: 2 }), 0);
  assert.equal(R.fitProgressFraction({ model: "x" }), null);
});

test("the models to test: the one in use first, downloaded only, at most 3", () => {
  const local = [{ id: "a", downloaded: true }, { id: "b", downloaded: false }, { id: "c", downloaded: true }, { id: "d", downloaded: true }, { id: "e", downloaded: true }];
  assert.deepEqual(R.fitPickModels(local, "d"), ["d", "a", "c"]);
  assert.deepEqual(R.fitPickModels(local, "b"), ["a", "c", "d"]);
  assert.deepEqual(R.fitPickModels(null, null), []);
});

/* ---------- renderer: what is drawn ---------- */

test("no card at all while the agent has no fit-test", () => {
  for (const supported of [null, false]) assert.equal(R.fitEntryHTML({ supported, phase: "idle" }, 3, { nameOf, currentId: null }, h), "");
});

test("the card: start, disabled under two downloaded models, progress with Cancel while running", () => {
  const idle = R.fitEntryHTML({ supported: true, phase: "idle" }, 3, { nameOf, currentId: null }, h);
  assert.match(idle, /Find the best model for my tasks/);
  assert.match(idle, /data-fit="start">Find the best model</);
  const few = R.fitEntryHTML({ supported: true, phase: "idle" }, 1, { nameOf, currentId: null }, h);
  assert.match(few, /data-fit="start" disabled/);
  assert.match(few, /Download at least two local models/);
  const running = R.fitEntryHTML({ supported: true, phase: "running", progress: { model: "qwen3-8b", phase: "loading" } }, 3, { nameOf, currentId: null }, h);
  assert.match(running, /Loading Qwen 3 8B…/);
  assert.match(running, /data-fit="cancel">Cancel</);
  assert.doesNotMatch(running, /data-fit="start"/);
  const done = R.fitEntryHTML({ supported: true, phase: "idle", result }, 3, { nameOf, currentId: null }, h);
  assert.match(done, /data-fit="open">Show results</);
  assert.match(done, />Run again</);
  assert.doesNotMatch(idle + few + running + done, /—/, "no long dashes in UI text");
});

test("the results table: one row per model, Switch on the others, In use on the current, the reason on a failed one", () => {
  const html = R.fitDialogHTML({ open: true, phase: "idle", result, switching: null }, { nameOf, currentId: "gemma4-4b" }, h);
  assert.match(html, /Right answers/);
  assert.match(html, /Speed/);
  assert.match(html, /Memory/);
  assert.match(html, /data-fit="use:qwen3-8b">Switch to this model</);
  assert.doesNotMatch(html, /data-fit="use:gemma4-4b"/);
  assert.match(html, /In use/);
  assert.match(html, /Did not finish: ran out of memory/);
  assert.doesNotMatch(html, /data-fit="use:llama-3b"/);
  assert.match(html, /Best fit/);
  // The best model is the first row.
  assert.ok(html.indexOf("Qwen 3 8B</span>") < html.indexOf("Gemma 4 4B</span>"));
  assert.doesNotMatch(html, /—/);
  const switching = R.fitDialogHTML({ open: true, phase: "idle", result, switching: "qwen3-8b" }, { nameOf, currentId: "gemma4-4b" }, h);
  assert.match(switching, /Switching…/);
  assert.equal(R.fitDialogHTML({ open: false, phase: "idle", result }, { nameOf, currentId: null }, h), "");
});

test("the sheet while running has a bar and Cancel test", () => {
  const html = R.fitDialogHTML({ open: true, phase: "running", progress: { model: "qwen3-8b", modelIndex: 1, models: 2, task: 6, tasks: 10, phase: "running" } },
    { nameOf, currentId: null }, h);
  assert.match(html, /aria-valuenow="25"/);
  assert.match(html, /data-fit="cancel">Cancel test</);
  const stopping = R.fitDialogHTML({ open: true, phase: "cancelling", progress: null }, { nameOf, currentId: null }, h);
  assert.match(stopping, /Stopping…/);
});
