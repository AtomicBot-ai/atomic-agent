// Unit tests for ATO-606 (the Fusion workers' reasoning level in the desktop):
// main/fusion-reasoning.ts (against the built output), the pure half of
// renderer/fusion-reasoning.js, the `/runmode reasoning` parse, and the
// wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/fusion-reasoning.js");
const { parseRunModeCommand } = require("../out/main/run-mode.js");
const R = require("../renderer/fusion-reasoning.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const cfgWith = (fusion) => ({ llm: { activeTextProvider: "openrouter", providers: [], runMode: { mode: "fusion", fusion } } });

/* ---------- the write plan (main) ---------- */

test("a level is written into llm.runMode.fusion, the other fusion keys kept", () => {
  const cfg = cfgWith({ workers: 3, workerModel: "qwen" });
  const v = M.planWorkerReasoning(cfg, "low");
  assert.equal(v.write, true);
  assert.equal(v.before, null);
  assert.equal(v.after, "low");
  assert.deepEqual(cfg.llm.runMode.fusion, { workers: 3, workerModel: "qwen", workerReasoning: "low" });
  assert.equal(cfg.llm.runMode.mode, "fusion");
});

test("Default removes the key instead of writing null", () => {
  const cfg = cfgWith({ workers: 2, workerReasoning: "high" });
  const v = M.planWorkerReasoning(cfg, "default");
  assert.equal(v.write, true);
  assert.equal(v.before, "high");
  assert.equal(v.after, null);
  assert.equal("workerReasoning" in cfg.llm.runMode.fusion, false);
  assert.deepEqual(cfg.llm.runMode.fusion, { workers: 2 });
});

test("nothing is written when the file already says the same", () => {
  const same = cfgWith({ workerReasoning: "medium" });
  assert.equal(M.planWorkerReasoning(same, "medium").write, false);
  const none = cfgWith({ workers: 2 });
  assert.equal(M.planWorkerReasoning(none, "default").write, false);
  const noFusion = { llm: { providers: [] } };
  assert.equal(M.planWorkerReasoning(noFusion, "default").write, false);
});

test("a level from a newer build reads as none, and Default removes it", () => {
  const cfg = cfgWith({ workerReasoning: "xhigh" });
  const v = M.planWorkerReasoning(cfg, "default");
  assert.equal(v.before, null);
  assert.equal(v.write, true);
  assert.equal("workerReasoning" in cfg.llm.runMode.fusion, false);
});

test("a file with no llm block is refused, not half-written", () => {
  const cfg = { localModels: { mode: "managed" } };
  const v = M.planWorkerReasoning(cfg, "low");
  assert.equal(v.write, false);
  assert.ok(v.refusal);
  assert.equal(cfg.llm, undefined);
});

test("a fusion block is created when the llm block has none", () => {
  const cfg = { llm: { providers: [] } };
  assert.equal(M.planWorkerReasoning(cfg, "high").write, true);
  assert.deepEqual(cfg.llm.runMode, { fusion: { workerReasoning: "high" } });
});

test("the route takes the four choices and nothing else", () => {
  for (const c of ["low", "medium", "high", "default"]) assert.equal(M.parseWorkerReasoningChoice(c), c);
  for (const c of ["", "Low", "max", null, undefined, 2, "none"]) assert.equal(M.parseWorkerReasoningChoice(c), null);
});

/* ---------- `/runmode reasoning` ---------- */

test("/runmode reasoning parses the four choices, case-insensitively", () => {
  assert.deepEqual(parseRunModeCommand("reasoning low"), { openSwitch: false, reasoning: "low" });
  assert.deepEqual(parseRunModeCommand(" Reasoning DEFAULT "), { openSwitch: false, reasoning: "default" });
  assert.deepEqual(parseRunModeCommand("reasoning high"), { openSwitch: false, reasoning: "high" });
});

test("/runmode reasoning with no level or a wrong one says the choices and the usage", () => {
  for (const bad of ["reasoning", "reasoning max", "reasoning low high"]) {
    const cmd = parseRunModeCommand(bad);
    assert.equal(cmd.reasoning, undefined);
    assert.match(cmd.error ?? "", /^reasoning must be low, medium, high or default — usage: \/runmode/);
  }
  assert.match(parseRunModeCommand("workers 9").error ?? "", /\/runmode reasoning low\|medium\|high\|default/);
});

test("the renderer's /runmode parse matches main's for the reasoning verb", () => {
  const r = src("../renderer/renderer.js");
  assert.ok(r.includes("const r = /^reasoning(?:\\s+(.+))?$/.exec(args);"));
  assert.ok(r.includes("'reasoning must be low, medium, high or default — ' + RUN_MODE_USAGE"));
  assert.ok(r.includes("/runmode workers N · /runmode reasoning low|medium|high|default · /runmode status';"));
  assert.ok(r.includes("if (cmd.reasoning !== undefined) { fzrSet(cmd.reasoning, true); return cmd; }"));
});

/* ---------- labels, level and help line (renderer) ---------- */

test("labels: Default · Low · Medium · High, in that order", () => {
  assert.deepEqual(R.FZR_CHOICES.map(R.fzrLabel), ["Default", "Low", "Medium", "High"]);
});

test("the lit level is the file's, and no key or an unknown value is Default", () => {
  assert.equal(R.fzrLevelOf(cfgWith({ workerReasoning: "medium" })), "medium");
  assert.equal(R.fzrLevelOf(cfgWith({ workers: 2 })), "default");
  assert.equal(R.fzrLevelOf(cfgWith({ workerReasoning: "xhigh" })), "default");
  assert.equal(R.fzrLevelOf(null), "default");
  assert.equal(R.fzrLevelOf({}), "default");
});

test("a typed choice is trimmed and lower-cased; anything else is null", () => {
  assert.equal(R.fzrParseChoice(" High "), "high");
  assert.equal(R.fzrParseChoice("default"), "default");
  assert.equal(R.fzrParseChoice("max"), null);
  assert.equal(R.fzrParseChoice(undefined), null);
});

test("the worker leg is read from its provider row; no row is the local one", () => {
  const cfg = { llm: { providers: [{ id: "openrouter", kind: "openrouter" }, { id: "local-llama", kind: "llama-server" }] } };
  assert.deepEqual(R.fzrWorkerLeg(cfg, "openrouter", "qwen/qwen3"), { kind: "openrouter", model: "qwen/qwen3" });
  assert.equal(R.fzrWorkerLeg(cfg, "local-llama", null).kind, "llama-server");
  assert.equal(R.fzrWorkerLeg(cfg, "gone", null).kind, "llama-server");
  assert.equal(R.fzrWorkerLeg(null, null, null).kind, "llama-server");
});

test("the help line says which providers get the level, and that it is the workers' only", () => {
  const line = (kind) => R.fzrHelpLine({ kind, model: null });
  assert.match(line("openrouter"), /OpenRouter as reasoning\.effort/);
  assert.match(line("openai-compatible"), /reasoning_effort/);
  assert.match(line("qwen-openai-compatible"), /reasoning_effort/);
  assert.match(line("gemini"), /Gemini models that think \(2\.5 and 3\)/);
  assert.match(line("aimlapi"), /OpenAI reasoning models on AI\/ML API/);
  assert.match(line("subscription-cli"), /takes no reasoning level, so nothing is sent/);
  for (const kind of ["openrouter", "llama-server", "gemini", "subscription-cli"]) {
    assert.match(line(kind), /Fusion workers only: the planner is not affected\.$/);
    assert.match(line(kind), /Default leaves the provider its own level/);
    // No long dashes in the window's prose.
    assert.equal(line(kind).includes("—"), false);
  }
});

test("with local workers the help line points to the local thinking knobs instead", () => {
  const line = R.fzrHelpLine({ kind: "llama-server", model: null });
  assert.match(line, /^Local llama\.cpp workers ignore this level\./);
  assert.match(line, /Settings › Models › Reasoning \(Thinking and Thinking budget\)/);
});

test("the saved line names the level, and an unchanged write says so", () => {
  assert.equal(R.fzrSavedLine("low", true), "Worker reasoning: Low.");
  assert.match(R.fzrSavedLine("default", true), /^Worker reasoning: Default/);
  assert.equal(R.fzrSavedLine("high", false), "Worker reasoning is already High.");
});

test("the control lights the level, sends runmode:reasoning:<choice> and is disabled while busy", () => {
  const html = R.fzrRowHTML("medium", { kind: "openrouter" }, false);
  for (const c of ["default", "low", "medium", "high"]) assert.ok(html.includes('data-act="runmode:reasoning:' + c + '"'));
  assert.ok(html.includes('class="on" data-act="runmode:reasoning:medium" aria-pressed="true"'));
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.ok(html.includes('aria-label="Worker reasoning"'));
  assert.equal(html.includes(" disabled"), false);
  assert.ok(R.fzrRowHTML("default", { kind: "openrouter" }, true).includes(" disabled"));
});

/* ---------- wiring ---------- */

test("the script, the bridge, the route and the Settings row are wired", () => {
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('<script src="fusion-reasoning.js"></script>') > html.indexOf('<script src="fusion-panel.js"></script>'));
  assert.ok(html.indexOf('<script src="fusion-reasoning.js"></script>') < html.indexOf('<script src="renderer.js"></script>'));
  assert.ok(src("../preload/preload.ts").includes('fusionWorkerReasoning: (level: string) => ipcRenderer.invoke("cli:fusionWorkerReasoning", level)'));
  const main = src("../main/main.ts");
  assert.ok(main.includes('import { wireFusionReasoningIpc } from "./fusion-reasoning-ipc.js";'));
  assert.ok(main.includes("wireFusionReasoningIpc();"));
  const ipc = src("../main/fusion-reasoning-ipc.ts");
  assert.ok(ipc.includes('ipcMain.handle("cli:fusionWorkerReasoning"'));
  // The compare-and-swap write (ATO-416), never the leaf `config set` that refuses llm.* keys.
  assert.ok(ipc.includes("rewriteWholeConfig((cfg) => planWorkerReasoning(cfg, parsed))"));
  const r = src("../renderer/renderer.js");
  assert.ok(r.includes("llmWorkersHTML(rm) + fzrSettingsHTML(rm)"));
  assert.ok(r.includes("if (rest.startsWith('reasoning:')) { fzrSet(rest.slice('reasoning:'.length)); return; }"));
});
