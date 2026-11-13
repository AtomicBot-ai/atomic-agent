// ATO-336: a slot count the user set explicitly (localModels.managed.parallel)
// wins over Fusion; only "auto" (or Fusion's own earlier write) follows the
// worker count.
// Against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planFusionWorkers, isParallelPin } = require("../out/main/run-mode.js");

const cfgOf = (parallel, workers) => ({
  llm: {
    activeTextProvider: "aimlapi",
    providers: [{ id: "aimlapi", kind: "openai-compatible", defaultChatModel: "m" }, { id: "local-llama", kind: "llama-server" }],
    runMode: { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "local-llama", ...(workers !== undefined ? { workers } : {}) } },
  },
  localModels: { mode: "managed", managed: { ...(parallel !== undefined ? { parallel } : {}) } },
});

test("user parallel 2 -> Fusion leaves it 2", () => {
  const cfg = cfgOf(2, undefined);
  const v = planFusionWorkers(cfg, 4);
  assert.equal(v.refusal, undefined);
  assert.equal(v.write, true);
  assert.equal(cfg.llm.runMode.fusion.workers, 4);
  assert.equal(cfg.localModels.managed.parallel, 2);
  assert.equal(v.notice, "fusion: 4 workers", "no restart hint: the slot count did not change");
});

test("a numeric-string pin from the terminal is kept too", () => {
  const cfg = cfgOf("2", 3);
  planFusionWorkers(cfg, 5);
  assert.equal(cfg.localModels.managed.parallel, "2");
});

test("auto -> Fusion sets parallel to the worker count", () => {
  const cfg = cfgOf("auto", undefined);
  const v = planFusionWorkers(cfg, 4);
  assert.equal(cfg.localModels.managed.parallel, 4);
  assert.match(v.notice, /restart the local model/);
});

test("missing parallel -> Fusion sets it", () => {
  const cfg = cfgOf(undefined, undefined);
  planFusionWorkers(cfg, 3);
  assert.equal(cfg.localModels.managed.parallel, 3);
});

test("a parallel equal to the stored worker count is Fusion's own write and keeps following", () => {
  const cfg = cfgOf(3, 3);
  planFusionWorkers(cfg, 2);
  assert.equal(cfg.localModels.managed.parallel, 2);
});

test("isParallelPin", () => {
  assert.equal(isParallelPin(undefined, undefined), false);
  assert.equal(isParallelPin("auto", 2), false);
  assert.equal(isParallelPin(" AUTO ", 2), false);
  assert.equal(isParallelPin("junk", 2), false);
  assert.equal(isParallelPin(2, undefined), true);
  assert.equal(isParallelPin(2, 4), true);
  assert.equal(isParallelPin(4, 4), false);
});
