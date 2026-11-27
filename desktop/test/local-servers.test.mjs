// ATO-2489: model servers already running here, in setup and Settings › Local.
// main/local-servers.ts reads `atag local-servers --json` (against the built
// output: npm run build && npm run test:unit); renderer/local-servers.js draws
// the Settings section and the setup step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/local-servers.js");
// The two renderer files share globals in the app (classic scripts); here
// each one's exports are put on globalThis so the other can find them.
const R = { ...require("../renderer/local-servers.js"), ...require("../renderer/local-servers-setup.js") };
Object.assign(globalThis, R);

const OLLAMA = { kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", presetId: "ollama", models: ["qwen3:8b", "llama3.2:3b"], loaded: ["qwen3:8b"] };
const LLAMA = { kind: "llama-app", label: "Llama app (llama.cpp)", baseUrl: "http://127.0.0.1:9931", presetId: null, models: ["gemma-3-4b"], loaded: [] };
const h = (ctx) => ({ esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]), ctx: ctx || {}, busy: false, machine: "this Mac" });

test("the command's JSON is read back, and rows it never writes are dropped", () => {
  const out = JSON.stringify({ servers: [LLAMA, OLLAMA, { kind: "other", baseUrl: "http://127.0.0.1:1" }, { kind: "ollama", baseUrl: "http://10.0.0.2:11434" }] });
  assert.deepEqual(M.parseLocalServers("log line\n" + out + "\n"), [LLAMA, OLLAMA]);
  assert.deepEqual(M.parseLocalServers('{"servers":[]}'), []);
  assert.equal(M.parseLocalServers("not json"), null);
  assert.equal(M.parseLocalServers('{"other":1}'), null);
  assert.equal(M.parseLocalServers(""), null);
});

test("an agent without the command is told apart from a failure", () => {
  assert.equal(M.isUnsupportedCommand("unknown command: local-servers\n"), true);
  assert.equal(M.isUnsupportedCommand("models failed: boom"), false);
  assert.equal(M.serverFacts(OLLAMA), "2 models, 1 loaded");
  assert.equal(M.serverFacts({ models: ["a"], loaded: [] }), "1 model");
});

test("setup's Custom card names what runs here", () => {
  assert.equal(R.lsvFoundSentence([LLAMA, OLLAMA]), "Found running here: Llama app, Ollama.");
  assert.equal(R.lsvFoundSentence([]), "");
});

test("loaded models come first and are marked; a long list is cut", () => {
  assert.equal(R.lsvModelsLine({ models: ["a", "b", "c"], loaded: ["c"] }, 4), "c (loaded), a, b");
  assert.equal(R.lsvModelsLine({ models: ["a", "b", "c", "d", "e"], loaded: [] }, 2), "a, b, and 3 more");
  assert.equal(R.lsvModelsLine({ models: [], loaded: [] }, 2), "");
});

test("a server is in use, added or new, and localhost is 127.0.0.1", () => {
  assert.equal(R.lsvStanding(OLLAMA, { activeId: "ollama", providers: ["ollama"] }), "in-use");
  assert.equal(R.lsvStanding(OLLAMA, { activeId: "openrouter", providers: ["ollama"] }), "added");
  assert.equal(R.lsvStanding(OLLAMA, { activeId: "openrouter", providers: [] }), "new");
  assert.equal(R.lsvStanding(LLAMA, { activeId: "local-llama", localMode: "external", localUrl: "http://localhost:9931/" }), "in-use");
  assert.equal(R.lsvStanding(LLAMA, { activeId: "local-llama", localMode: "managed", localUrl: "http://127.0.0.1:9931" }), "new");
  assert.equal(R.lsvSameUrl("http://localhost:11434/v1", "http://127.0.0.1:11434"), true);
  assert.equal(R.lsvSameUrl("http://127.0.0.1:1234", "http://127.0.0.1:11434"), false);
});

test("Settings: loading, error, empty and the list share one card; hidden draws nothing", () => {
  const base = { servers: [], error: null };
  assert.equal(R.lsvSectionHTML({ ...base, phase: "hidden" }, h()), "");
  assert.equal(R.lsvSectionHTML({ ...base, phase: "idle" }, h()), "");
  const loading = R.lsvSectionHTML({ ...base, phase: "loading" }, h());
  assert.match(loading, /Looking for Ollama, LM Studio and the Llama app/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(R.lsvSectionHTML({ ...base, phase: "error", error: "Could not look for running model servers." }, h()), /role="alert"/);
  assert.match(R.lsvSectionHTML({ ...base, phase: "ready" }, h()), /Nothing is running right now/);
  const list = R.lsvSectionHTML({ ...base, phase: "ready", servers: [OLLAMA, LLAMA] }, h({ activeId: "ollama", providers: ["ollama"] }));
  for (const html of [loading, list]) assert.match(html, /Running on this Mac/);
  assert.match(list, /2 models, 1 loaded · 127\.0\.0\.1:11434/);
  assert.match(list, /In use/);
  assert.match(list, /data-lsv="use:1"/);
  assert.doesNotMatch(list, /data-lsv="use:0"/);
  // Raw errors and paths never reach the card.
  assert.doesNotMatch(list, /\/Users\//);
});

test("a server with no model says what to do, in words", () => {
  const html = R.lsvRowHTML({ ...OLLAMA, models: [], loaded: [] }, 0, h());
  assert.match(html, /No models yet\. Pull one in Ollama/);
});

test("the found step lists every server and then Something else", () => {
  R.LSV.servers = [LLAMA, OLLAMA];
  const rows = R.lsvObRows();
  assert.deepEqual(rows.map((r) => r.kind), ["server", "server", "other"]);
  assert.equal(rows[0].server, LLAMA);
});

test("the closing line names the server only when setup ended on it", () => {
  globalThis.WIZ = { savedId: "ollama", row: null };
  globalThis.OB = { chatUrl: "http://127.0.0.1:9931" };
  R.LSV.obPicked = OLLAMA;
  assert.equal(R.lsvObConfiguredLabel("cloud"), "Ollama connected");
  globalThis.WIZ = { savedId: "openrouter", row: null };
  assert.equal(R.lsvObConfiguredLabel("cloud"), "");
  R.LSV.obPicked = LLAMA;
  assert.equal(R.lsvObConfiguredLabel("custom"), "Llama app connected");
  globalThis.OB = { chatUrl: "http://127.0.0.1:8080" };
  assert.equal(R.lsvObConfiguredLabel("custom"), "");
  R.LSV.obPicked = null;
  assert.equal(R.lsvObConfiguredLabel("cloud"), "");
  delete globalThis.WIZ; delete globalThis.OB;
});

test("the Custom list's Ollama row says Running only when it was found", () => {
  R.LSV.phase = "ready"; R.LSV.servers = [OLLAMA];
  assert.match(R.lsvRunningBadge("ollama"), /Running/);
  assert.equal(R.lsvRunningBadge("lmstudio"), "");
  R.LSV.phase = "error";
  assert.equal(R.lsvRunningBadge("ollama"), "");
});

test("Custom opens the found step only when something runs", () => {
  const steps = [];
  globalThis.obDispatch = (a) => steps.push(a);
  R.LSV.phase = "ready"; R.LSV.servers = [];
  assert.equal(R.lsvObOffer(), false);
  R.LSV.servers = [OLLAMA];
  assert.equal(R.lsvObOffer(), true);
  assert.deepEqual(steps, [{ type: "onboarding_step_set", step: "found_server" }]);
  R.LSV.phase = "hidden";
  assert.equal(R.lsvObOffer(), false);
  delete globalThis.obDispatch;
});
