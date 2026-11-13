// ATO-1091: Settings › Models › "Find the best model for my tasks".
// main/fit-test.ts reads what `atag models fit-test --json` (ATO-1090, PR #1367) prints
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
const judgeWord = (id) => ({ ollama: "Ollama", openrouter: "OpenRouter" })[id] || id;
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

/* ---------- main: aligned with the agent's PR #1367 ---------- */

// What `atag models fit-test --json` prints at the end (src/fit-test/fit-test-types.ts FitTestRun).
const run = {
  kind: "atomic-agent.fit-test-run",
  version: 1,
  createdAt: "2026-11-12T10:00:00.000Z",
  taskSetCreatedAt: "2026-11-12T09:59:00.000Z",
  taskIds: ["t1", "t2", "t3", "t4"],
  gpuBudgetGb: 12,
  models: [
    { modelId: "qwen3-8b", loadError: null, loadMs: 4000, peakMemoryBytes: 5.2 * GB, tasks: [
      { taskId: "t1", score: 5, reason: "ok", durationMs: 10000, tokens: 900, timedOut: false },
      { taskId: "t2", score: 4, reason: "ok", durationMs: 14000, tokens: 800, timedOut: false },
      { taskId: "t3", score: 2, reason: "missed", durationMs: 12000, tokens: 700, timedOut: false },
      { taskId: "t4", score: null, reason: "judge failed: 500", durationMs: 12000, tokens: null, timedOut: false },
    ] },
    { modelId: "gemma4-4b", loadError: "the model did not start (is it downloaded?)", loadMs: 900, peakMemoryBytes: null, tasks: [] },
    { modelId: "llama-3b", loadError: null, loadMs: 2000, peakMemoryBytes: 2 * GB, tasks: [
      { taskId: "t1", score: null, reason: "run failed: exit 1", durationMs: 0, tokens: null, timedOut: false },
    ] },
  ],
};

test("the entry shows only when `atag models --help` lists fit-test", () => {
  const help = "Fit-test subcommands:\n  tasks collect [--last <n>]    Write your last n tasks\n  fit-test --tasks <file>       Run the set on up to 3 models\n";
  assert.equal(M.fitTestListed(help), true);
  assert.equal(M.fitTestListed("Subcommands:\n  list   Show\n  recommend [--json]  what fits\n"), false);
  assert.equal(M.fitTestListed(""), false);
});

test("a run becomes the window's result: passed of the set, average task time, peak memory, no winner from the agent", () => {
  const r = M.fitResultFromStdout(JSON.stringify(run, null, 2) + "\n");
  assert.equal(r.tasks, 4);
  assert.equal(r.winner, null);
  const [qwen, gemma, llama] = r.models;
  assert.equal(qwen.id, "qwen3-8b");
  assert.equal(qwen.passed, 2, "score 4 or more passes");
  assert.equal(qwen.total, 4, "out of the whole set, an ungraded task counts as not passed");
  assert.equal(qwen.accuracy, 0.5);
  assert.equal(qwen.meanScore, 11 / 3);
  assert.equal(qwen.avgSeconds, 12);
  assert.equal(qwen.peakMemoryBytes, 5.2 * GB);
  assert.equal(qwen.error, null);
  assert.equal(gemma.error, "the model did not start (is it downloaded?)");
  assert.equal(gemma.accuracy, null);
  assert.match(llama.error, /^no answer could be graded \(run failed: exit 1\)$/);
  assert.equal(llama.passed, null);
});

test("anything that is not a fit-test run reads as no result", () => {
  assert.equal(M.fitResultFromStdout(""), null);
  assert.equal(M.fitResultFromStdout("the task set is empty"), null);
  assert.equal(M.fitResultFromStdout(JSON.stringify({ kind: "something-else", models: run.models })), null);
  assert.equal(M.fitResultFromStdout(JSON.stringify({ ...run, models: [] })), null);
  assert.equal(M.fitResultFromStdout("{broken"), null);
});

test("progress is read from the run's stderr lines", () => {
  const ids = ["qwen3-8b", "gemma4-4b"];
  assert.deepEqual(M.parseFitProgressLine("gemma4-4b: task 3/10 Fix the failing test", ids),
    { model: "gemma4-4b", modelIndex: 2, models: 2, task: 3, tasks: 10, phase: "running" });
  assert.equal(M.parseFitProgressLine("qwen3-8b: unload failed: boom", ids), null);
  assert.equal(M.parseFitProgressLine("--judge-url is required", ids), null);
  assert.equal(M.parseFitProgressLine("other: task 1/2", ids).modelIndex, null);
});

test("`models tasks collect --json` gives the set's path and size", () => {
  assert.deepEqual(M.readCollected('{"ok":true,"path":"/tmp/x/tasks.json","tasks":7,"skipped":{"sent outside":1}}\n'), { path: "/tmp/x/tasks.json", tasks: 7 });
  assert.equal(M.readCollected("wrote 7 task(s) to /tmp/x"), null);
  assert.equal(M.readCollected('{"ok":false}'), null);
});

test("--models goes with 2 or 3 ids `models use` takes, never one or junk", () => {
  assert.deepEqual(M.fitModelIds(["a", "b"]), ["a", "b"]);
  assert.deepEqual(M.fitModelIds(["a", "b", "c", "d"]), ["a", "b", "c"]);
  assert.equal(M.fitModelIds(["a", "a"]), null);
  assert.equal(M.fitModelIds(["a", "b;rm -rf"]), null);
  assert.equal(M.fitModelIds(null), null);
});

const config = { llm: { providers: [
  { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" },
  { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", defaultChatModel: "openai/gpt-5-mini" },
  { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", defaultChatModel: "qwen3:8b" },
  { id: "mine", kind: "openai-compatible", baseUrl: "https://llm.example.com", model: "big", apiKey: "sk-inline" },
  { id: "named", kind: "openai-compatible", baseUrl: "https://x.example.com/v1", defaultChatModel: "m", apiKeyEnvVar: "MY_KEY" },
  { id: "nomodel", kind: "openai-compatible", baseUrl: "https://y.example.com" },
  { id: "claude-cli", kind: "subscription-cli", subscriptionCli: { cli: "claude" } },
] } };

test("the judges: OpenAI-compatible providers with an address and a model, local ones marked", () => {
  const j = M.fitJudges(config);
  assert.deepEqual(j.map((x) => x.id), ["openrouter", "ollama", "mine", "named"]);
  assert.equal(j.find((x) => x.id === "ollama").local, true);
  assert.equal(j.find((x) => x.id === "openrouter").local, false);
  assert.deepEqual(M.fitJudges(null), []);
});

test("the judge flags: the key travels by env var name, never on the command line", () => {
  const keyEnvOf = (id) => ({ openrouter: "OPENROUTER_API_KEY" })[id];
  assert.deepEqual(M.fitJudgeArgs(config, "openrouter", keyEnvOf), {
    args: ["--judge-url", "https://openrouter.ai/api/v1", "--judge-model", "openai/gpt-5-mini", "--judge-key-env", "OPENROUTER_API_KEY"], env: {} });
  assert.deepEqual(M.fitJudgeArgs(config, "named", keyEnvOf).args.slice(-2), ["--judge-key-env", "MY_KEY"]);
  const inline = M.fitJudgeArgs(config, "mine", keyEnvOf);
  assert.deepEqual(inline.env, { FIT_JUDGE_API_KEY: "sk-inline" });
  assert.ok(!inline.args.includes("sk-inline"));
  assert.deepEqual(M.fitJudgeArgs(config, "ollama", keyEnvOf).args, ["--judge-url", "http://localhost:11434/v1", "--judge-model", "qwen3:8b"]);
  assert.ok("error" in M.fitJudgeArgs(config, "nomodel", keyEnvOf));
  assert.ok("error" in M.fitJudgeArgs(config, null, keyEnvOf));
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
  assert.equal(R.fitProgressLine({ phase: "collecting" }, nameOf), "Collecting your recent tasks…");
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
  for (const supported of [null, false]) assert.equal(R.fitEntryHTML({ supported, phase: "idle" }, 3, { nameOf, judgeWord, currentId: null }, h), "");
});

test("the card: start, disabled under two downloaded models, progress with Cancel while running", () => {
  const judges = [{ id: "ollama", model: "qwen3:8b", local: true }, { id: "openrouter", model: "gpt", local: false }];
  const idle = R.fitEntryHTML({ supported: true, phase: "idle", judges, judge: "ollama" }, 3, { nameOf, judgeWord, currentId: null }, h);
  assert.match(idle, /Find the best model for my tasks/);
  assert.match(idle, /data-fit="start">Find the best model</);
  assert.match(idle, /stay on this computer: Ollama grades them/);
  // Nothing is picked for the person: no judge, no start.
  const unpicked = R.fitEntryHTML({ supported: true, phase: "idle", judges, judge: null }, 3, { nameOf, judgeWord, currentId: null }, h);
  assert.match(unpicked, /<option value="" selected>Choose…<\/option>/);
  assert.match(unpicked, /data-fit="start" disabled/);
  const cloud = R.fitEntryHTML({ supported: true, phase: "idle", judges, judge: "openrouter" }, 3, { nameOf, judgeWord, currentId: null }, h);
  assert.match(cloud, /sent to OpenRouter to be graded/);
  const none = R.fitEntryHTML({ supported: true, phase: "idle", judges: [], judge: null }, 3, { nameOf, judgeWord, currentId: null }, h);
  assert.match(none, /add a cloud provider, or an app like Ollama or LM Studio/);
  assert.match(none, /data-fit="start" disabled/);
  const few = R.fitEntryHTML({ supported: true, phase: "idle", judges, judge: "ollama" }, 1, { nameOf, judgeWord, currentId: null }, h);
  assert.match(few, /data-fit="start" disabled/);
  assert.match(few, /Download at least two local models/);
  const running = R.fitEntryHTML({ supported: true, phase: "running", progress: { model: "qwen3-8b", phase: "loading" } }, 3, { nameOf, judgeWord, currentId: null }, h);
  assert.match(running, /Loading Qwen 3 8B…/);
  assert.match(running, /data-fit="cancel">Cancel</);
  assert.doesNotMatch(running, /data-fit="start"/);
  const done = R.fitEntryHTML({ supported: true, phase: "idle", result, judges, judge: "ollama" }, 3, { nameOf, judgeWord, currentId: null }, h);
  assert.match(done, /data-fit="open">Show results</);
  assert.match(done, />Run again</);
  assert.doesNotMatch(idle + few + running + done + unpicked + cloud + none, /—/, "no long dashes in UI text");
});

test("the results table: one row per model, Switch on the others, In use on the current, the reason on a failed one", () => {
  const html = R.fitDialogHTML({ open: true, phase: "idle", result, switching: null }, { nameOf, judgeWord, currentId: "gemma4-4b" }, h);
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
  const switching = R.fitDialogHTML({ open: true, phase: "idle", result, switching: "qwen3-8b" }, { nameOf, judgeWord, currentId: "gemma4-4b" }, h);
  assert.match(switching, /Switching…/);
  assert.equal(R.fitDialogHTML({ open: false, phase: "idle", result }, { nameOf, judgeWord, currentId: null }, h), "");
});

test("the sheet while running has a bar and Cancel test", () => {
  const html = R.fitDialogHTML({ open: true, phase: "running", progress: { model: "qwen3-8b", modelIndex: 1, models: 2, task: 6, tasks: 10, phase: "running" } },
    { nameOf, judgeWord, currentId: null }, h);
  assert.match(html, /aria-valuenow="25"/);
  assert.match(html, /data-fit="cancel">Cancel test</);
  const stopping = R.fitDialogHTML({ open: true, phase: "cancelling", progress: null }, { nameOf, judgeWord, currentId: null }, h);
  assert.match(stopping, /Stopping…/);
});

/* ---------- review: Send is held while a test runs ---------- */

test("while a fit-test runs, Send on the local model is held with a notice; after it ends or is cancelled it works again", async () => {
  assert.equal(R.FIT_HOLD_TITLE, "A model test is running");
  assert.match(R.FIT_HOLD_TEXT, /Chat is back when it ends or you cancel it/);
  assert.doesNotMatch(R.FIT_HOLD_TITLE + R.FIT_HOLD_TEXT, /—/);
  // The rule: held in every phase but idle, unless the chat does not use the managed server.
  assert.equal(R.fitHoldsSendFor("idle", "local"), false);
  for (const phase of ["running", "cancelling"]) {
    for (const backend of ["local", "fusion", null]) assert.equal(R.fitHoldsSendFor(phase, backend), true, `${phase}/${backend}`);
    assert.equal(R.fitHoldsSendFor(phase, "cloud"), false);
    assert.equal(R.fitHoldsSendFor(phase, "custom"), false);
  }

  // The real flow through fitStart / fitCancel, with the bridge faked.
  let answer = null;
  globalThis.BR = {
    fitTestSupported: async () => true,
    fitTestStart: () => new Promise((resolve) => { answer = resolve; }),
    fitTestCancel: async () => { answer({ ok: false, cancelled: true }); return { ok: true }; },
  };
  globalThis.selBackend = () => "local";
  try {
    assert.equal(R.fitHoldsSend(), false, "nothing held before a run");
    // A run that ends with a result.
    const first = R.fitStart();
    await new Promise((r) => setImmediate(r));
    assert.equal(R.fitHoldsSend(), true, "held while running");
    globalThis.selBackend = () => "cloud";
    assert.equal(R.fitHoldsSend(), false, "a cloud chat goes through");
    globalThis.selBackend = () => "local";
    answer({ ok: true, result });
    await first;
    assert.equal(R.fitHoldsSend(), false, "back after the run ends");
    // A run that is cancelled: held through the cancel until main answers.
    const second = R.fitStart();
    await new Promise((r) => setImmediate(r));
    assert.equal(R.fitHoldsSend(), true);
    const cancel = R.fitCancel();
    assert.equal(R.fitHoldsSend(), true, "still held while stopping");
    await cancel;
    await second;
    assert.equal(R.fitHoldsSend(), false, "back after a cancel");
  } finally {
    delete globalThis.BR;
    delete globalThis.selBackend;
  }
});

/* ---------- review: Cancel ends the run's whole tree ---------- */

test("cancel: taskkill /T /F on the run's pid on Windows, the process group on macOS and Linux", () => {
  const calls = [];
  const deps = (platform) => ({
    platform,
    systemRoot: "C:\\Windows",
    spawn: (command, args, opts) => { calls.push({ spawn: command, args, opts }); return { on: () => {} }; },
    kill: (pid, sig) => { calls.push({ kill: pid, sig }); },
  });
  const child = { pid: 4242, kill: (sig) => { calls.push({ childKill: sig }); return true; } };

  M.stopFitTest(child, deps("win32"));
  assert.deepEqual(calls, [{
    spawn: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "4242", "/T", "/F"],
    opts: { stdio: "ignore", windowsHide: true, shell: false },
  }]);

  calls.length = 0;
  M.stopFitTest(child, deps("darwin"));
  assert.deepEqual(calls, [{ kill: -4242, sig: "SIGTERM" }]);

  calls.length = 0;
  M.stopFitTest(child, deps("linux"));
  assert.deepEqual(calls, [{ kill: -4242, sig: "SIGTERM" }]);

  // No taskkill to run on Windows: the one process at least.
  calls.length = 0;
  M.stopFitTest(child, { ...deps("win32"), spawn: () => ({ on: (ev, cb) => { if (ev === "error") cb(); } }) });
  assert.deepEqual(calls, [{ childKill: "SIGTERM" }]);

  // The group is gone already: the one process.
  calls.length = 0;
  M.stopFitTest(child, { ...deps("darwin"), kill: () => { throw new Error("ESRCH"); } });
  assert.deepEqual(calls, [{ childKill: "SIGTERM" }]);
});
