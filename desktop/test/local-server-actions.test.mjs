// ATO-2490: Manage on an Ollama / LM Studio row in Settings › Local.
// main/local-servers.ts checks what the renderer asks and reads the result of
// `atag local-servers <action> ... --json` (against the built output: npm run
// build && npm run test:unit); renderer/local-servers.js draws the panel and
// runs the actions through window.atomic (BR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/local-servers.js");
const R = require("../renderer/local-servers.js");

const OLLAMA = { kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", presetId: "ollama", models: ["qwen3:8b", "llama3.2:3b"], loaded: ["qwen3:8b"] };
const LMS = { kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234", presetId: "lmstudio", models: ["qwen/qwen3-8b"], loaded: [] };
const LLAMA = { kind: "llama-app", label: "Llama app (llama.cpp)", baseUrl: "http://127.0.0.1:9931", presetId: null, models: ["gemma-3-4b"], loaded: [] };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const h = (st) => ({ esc, ctx: {}, busy: false, machine: "this Mac", canAct: true, st });
const fresh = (over) => Object.assign({ phase: "ready", servers: [OLLAMA, LMS, LLAMA], open: null, act: null, progress: null, note: null, confirm: null, pull: { ollama: "", lmstudio: "" } }, over || {});

test("only actions this app offers reach the agent, always with --json", () => {
  const ok = (raw) => { const a = M.readActionInput(raw); assert.ok(!("error" in a), JSON.stringify(a)); return M.actionArgs(a); };
  assert.deepEqual(ok({ action: "unload", kind: "ollama", all: true }), ["local-servers", "unload", "ollama", "--all", "--json"]);
  assert.deepEqual(ok({ action: "pull", kind: "lmstudio", model: " qwen/qwen3-8b " }), ["local-servers", "pull", "lmstudio", "qwen/qwen3-8b", "--json"]);
  assert.deepEqual(ok({ action: "adopt", kind: "ollama", model: "qwen3:8b", copy: true }), ["local-servers", "adopt", "ollama", "qwen3:8b", "--copy", "--json"]);
  assert.deepEqual(ok({ action: "start", kind: "ollama" }), ["local-servers", "start", "ollama", "--json"]);
  // A name that reads as a flag, a delete on LM Studio, the Llama app, a made-up action: refused here.
  assert.ok("error" in M.readActionInput({ action: "load", kind: "ollama", model: "--use" }));
  assert.ok("error" in M.readActionInput({ action: "rm", kind: "lmstudio", model: "a" }));
  assert.ok("error" in M.readActionInput({ action: "load", kind: "llama-app", model: "a" }));
  assert.ok("error" in M.readActionInput({ action: "serve", kind: "ollama" }));
  assert.ok("error" in M.readActionInput({ action: "load", kind: "ollama" }));
});

test("the result line is the answer; progress lines are steps; no result is words", () => {
  const out = '{"type":"progress","status":"pulling abc","completed":40,"total":100}\n'
    + '{"type":"result","ok":true,"action":"adopt","kind":"ollama","id":"custom-local-x-1","name":"x (from Ollama)","how":"hardlink"}\n';
  assert.deepEqual(M.actionAnswer(out, "", 0), { ok: true, id: "custom-local-x-1", name: "x (from Ollama)", how: "hardlink" });
  assert.deepEqual(M.readActionLine(out.split("\n")[0]), { progress: { status: "pulling abc", completed: 40, total: 100 } });
  const failed = '{"type":"result","ok":false,"error":"Ollama is not answering. Start it and try again.","detail":"fetch failed"}';
  assert.deepEqual(M.actionAnswer(failed, "", 1), { ok: false, error: "Ollama is not answering. Start it and try again.", detail: "fetch failed" });
  assert.match(M.actionAnswer("", "unknown command: local-servers", 2).error, /cannot manage model servers yet/);
  assert.equal(M.actionAnswer("", "", null).error, "The action was stopped.");
  assert.equal(M.progressWords({ status: "x", completed: 2.1e9, total: 5e9 }), "2.1 of 5.0 GB (42%)");
});

test("Manage shows on Ollama and LM Studio rows only, and opens their models", () => {
  const st = fresh({ open: "ollama" });
  const html = R.lsvSectionHTML(st, h(st));
  assert.equal((html.match(/data-lsv="manage:/g) || []).length, 2);
  assert.match(html, /data-lsv-panel="ollama"/);
  assert.doesNotMatch(html, /data-lsv-panel="lmstudio"/);
  // qwen3:8b is loaded: Unload; llama3.2:3b is not: Load. Delete on Ollama; Free memory since one is loaded.
  assert.match(html, /data-lsv="unload:0:0"/);
  assert.match(html, /data-lsv="load:0:1"/);
  assert.match(html, /data-lsv="rm:0:1"/);
  assert.match(html, /data-lsv="adopt:0:0"/);
  assert.match(html, /data-lsv="freeall:0"/);
  assert.match(html, /data-lsv="pull:0"/);
  // No Manage without the bridge (an older app build).
  const none = R.lsvSectionHTML(st, Object.assign(h(st), { canAct: false }));
  assert.doesNotMatch(none, /data-lsv="manage:/);
});

test("LM Studio has no Delete; a delete on Ollama asks first", () => {
  const lm = R.lsvManageHTML(LMS, 1, h(fresh({ open: "lmstudio" })));
  assert.doesNotMatch(lm, /data-lsv="rm:/);
  const asking = R.lsvManageHTML(OLLAMA, 0, h(fresh({ open: "ollama", confirm: "ollama:llama3.2:3b" })));
  assert.match(asking, /Delete llama3\.2:3b from Ollama\?/);
  assert.match(asking, /data-lsv="rmyes:0:1"/);
  assert.match(asking, /data-lsv="rmno"/);
});

test("a download shows its progress and Stop; a failure shows Details", () => {
  const pulling = R.lsvManageHTML(OLLAMA, 0, h(fresh({
    act: { action: "pull", kind: "ollama", model: "qwen3:14b", key: "ollama:qwen3:14b" },
    progress: { status: "pulling", completed: 1e9, total: 4e9 },
  })));
  assert.match(pulling, /Downloading qwen3:14b/);
  assert.match(pulling, /1\.0 of 4\.0 GB \(25%\)/);
  assert.match(pulling, /data-lsv="stop"/);
  const failed = R.lsvManageHTML(OLLAMA, 0, h(fresh({ note: { kind: "ollama", ok: false, text: "Ollama could not load x.", detail: "model requires more system memory" } })));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /<summary>Details<\/summary><pre>model requires more system memory<\/pre>/);
});

test("Start is offered for the apps that did not answer", () => {
  const st = fresh({ servers: [LLAMA] });
  const html = R.lsvStartHTML(st, h(st));
  assert.match(html, /data-lsv="start:ollama"/);
  assert.match(html, /data-lsv="start:lmstudio"/);
  const both = fresh();
  assert.equal(R.lsvStartHTML(both, h(both)), "");
});

test("an action goes through the bridge, says what happened, and looks again", async () => {
  const calls = [];
  globalThis.BR = {
    localServersAct: async (a) => { calls.push(a); return a.model === "bad" ? { ok: false, error: "Ollama could not load bad.", detail: "nope" } : { ok: true }; },
    localServersDetect: async () => { calls.push("detect"); return { ok: true, servers: [OLLAMA] }; },
  };
  try {
    R.LSV.servers = [OLLAMA]; R.LSV.phase = "ready"; R.LSV.act = null;
    await R.lsvAct({ action: "unload", kind: "ollama", model: "qwen3:8b" });
    assert.deepEqual(calls[0], { action: "unload", kind: "ollama", model: "qwen3:8b", all: false });
    assert.deepEqual(R.LSV.note, { kind: "ollama", ok: true, text: "qwen3:8b is unloaded. Its memory is free.", detail: null });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.includes("detect"));
    R.LSV.phase = "ready";
    await R.lsvAct({ action: "load", kind: "ollama", model: "bad" });
    assert.deepEqual(R.LSV.note, { kind: "ollama", ok: false, text: "Ollama could not load bad.", detail: "nope" });
    // Download with an empty field asks for a name and runs nothing.
    const before = calls.length;
    R.LSV.pull.ollama = "  ";
    R.lsvManageClick("pull:0");
    assert.equal(calls.length, before);
    assert.match(R.LSV.note.text, /Type the name of a model/);
  } finally {
    delete globalThis.BR;
  }
});
