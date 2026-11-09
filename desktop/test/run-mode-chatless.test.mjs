// ATO-880: an openai-compatible entry with no defaultChatModel is
// embedding-only, and as a Fusion seat it fails on the first message. The
// agent's own setMode stopped picking or accepting one in #820; the desktop's
// planEnterFusion (its port of setMode) still did.
// Against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planEnterFusion, entryHasNoChatModel } = require("../out/main/run-mode.js");

const EMBED_ONLY = { id: "embed-only", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9000/v1" };
const CHAT = { id: "deepseek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", defaultChatModel: "deepseek-v4-flash" };
const LOCAL = { id: "local-llama", kind: "llama-server" };

const cfgOf = (active, providers, runMode) => ({
  llm: { activeTextProvider: active, providers: JSON.parse(JSON.stringify(providers)), ...(runMode ? { runMode } : {}) },
});

test("entryHasNoChatModel matches the agent's guard", () => {
  assert.equal(entryHasNoChatModel(EMBED_ONLY), true);
  assert.equal(entryHasNoChatModel({ ...EMBED_ONLY, kind: "qwen-openai-compatible" }), true);
  assert.equal(entryHasNoChatModel({ ...EMBED_ONLY, defaultChatModel: "  " }), true);
  assert.equal(entryHasNoChatModel(CHAT), false);
  assert.equal(entryHasNoChatModel(LOCAL), false, "a llama-server serves what its daemon loaded");
  assert.equal(entryHasNoChatModel({ id: "or", kind: "openrouter" }), false);
  assert.equal(entryHasNoChatModel(undefined), false);
});

test("from the local route the orchestrator skips an embedding-only provider listed first", () => {
  const cfg = cfgOf("local-llama", [LOCAL, EMBED_ONLY, CHAT]);
  const v = planEnterFusion(cfg, {}, () => true);
  assert.equal(v.refusal, undefined);
  assert.equal(cfg.llm.activeTextProvider, "deepseek");
  assert.equal(cfg.llm.runMode.fusion.orchestratorProvider, "deepseek");
  assert.equal(cfg.llm.runMode.fusion.workerProvider, "local-llama");
});

test("an embedding-only provider is not picked as the worker either", () => {
  const cfg = cfgOf("deepseek", [CHAT, EMBED_ONLY, { id: "openrouter", kind: "openrouter", defaultChatModel: "qwen/qwen3.7-flash" }]);
  const v = planEnterFusion(cfg, {}, () => true);
  assert.equal(v.refusal, undefined);
  assert.equal(cfg.llm.runMode.fusion.workerProvider, "openrouter");
});

test("with no second chat provider, Fusion is refused rather than seated on the embedding one", () => {
  const cfg = cfgOf("deepseek", [CHAT, EMBED_ONLY]);
  const before = JSON.stringify(cfg);
  const v = planEnterFusion(cfg, {}, () => true);
  assert.equal(v.write, false);
  assert.match(v.refusal, /two providers|second/i);
  assert.equal(JSON.stringify(cfg), before, "nothing is written");
});

test("a pin naming an embedding-only provider is refused and writes nothing", () => {
  const cfg = cfgOf("deepseek", [LOCAL, CHAT, EMBED_ONLY]);
  const before = JSON.stringify(cfg);
  const asWorker = planEnterFusion(cfg, { workerProvider: "embed-only" }, () => true);
  assert.equal(asWorker.write, false);
  assert.match(asWorker.refusal, /"embed-only" has no chat model/);
  const asOrchestrator = planEnterFusion(cfg, { orchestratorProvider: "embed-only" }, () => true);
  assert.equal(asOrchestrator.write, false);
  assert.match(asOrchestrator.refusal, /"embed-only" has no chat model/);
  assert.equal(JSON.stringify(cfg), before);
});
