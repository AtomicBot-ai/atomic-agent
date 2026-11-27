// ATO-2482: Settings › Models › Sampling. renderer/model-sampling.js turns
// `atag models sampling <id> --json` into the "Model default / Custom" row and
// the per-mode boxes; main/model-sampling.ts builds the calls and reads the
// answer (against the built output: npm run build && npm run test:unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/model-sampling.js");
const M = require("../out/main/model-sampling.js");

const report = {
  id: "qwen-3.5-4b",
  name: "Qwen3.5 4B",
  source: "default",
  custom: null,
  catalog: { topK: 20, thinking: { temperature: 1, topP: 0.95 }, noThinking: { temperature: 0.7, topP: 0.8 } },
  file: null,
  modelSampling: true,
};

test("what each mode runs with: own values, then the model's (switch on), then built-in", () => {
  assert.deepEqual(R.msShownFor(report, "noThinking"), { temperature: 0.7, topP: 0.8, topK: 20 });
  assert.deepEqual(R.msShownFor({ ...report, modelSampling: false }, "thinking"), { temperature: 0.2, topP: 0.95, topK: 40 });
  const own = { ...report, source: "custom", custom: { temperature: 0.4, thinking: { topK: 10 } } };
  assert.deepEqual(R.msShownFor(own, "thinking"), { temperature: 0.4, topP: 0.95, topK: 10 });
});

test("the boxes hold only the person's own values; the placeholder shows the fallback", () => {
  const own = { ...report, source: "custom", custom: { noThinking: { temperature: 0.5 } } };
  const draft = R.msDraftFromReport(own);
  assert.equal(draft.noThinking.temperature, "0.5");
  assert.equal(draft.thinking.temperature, "");
  assert.equal(R.msPlaceholder(own, "noThinking", "temperature"), "0.7");
});

test("a draft becomes one set per mode, blanks left out, and out-of-range values are named", () => {
  const draft = { thinking: { temperature: "1", topP: "", topK: "", minP: "" }, noThinking: { temperature: "", topP: "0.8", topK: "20", minP: "" } };
  assert.equal(R.msValidate(draft), null);
  assert.deepEqual(R.msSetFromDraft(draft), { thinking: { temperature: 1 }, noThinking: { topP: 0.8, topK: 20 } });
  assert.deepEqual(R.msSetFromDraft({ thinking: {}, noThinking: {} }), {});
  assert.match(R.msValidate({ thinking: { temperature: "9" }, noThinking: {} }), /Thinking on: Temperature is from 0 to 5/);
  assert.match(R.msValidate({ thinking: {}, noThinking: { topP: "0" } }), /Top P is above 0/);
  assert.match(R.msValidate({ thinking: { topK: "2.5" }, noThinking: {} }), /whole number/);
});

test("Save keeps the fields the boxes do not show, set from the terminal", () => {
  const custom = { presencePenalty: 1.5, temperature: 0.6, noThinking: { repeatPenalty: 1.05, topK: 30 } };
  const draft = { thinking: { temperature: "" }, noThinking: { temperature: "0.5", topK: "" } };
  assert.deepEqual(R.msSetFromDraft(draft, custom), {
    presencePenalty: 1.5,
    noThinking: { repeatPenalty: 1.05, temperature: 0.5 },
  });
  // Every box empty: the hidden fields stay, so Save does not reset them.
  assert.deepEqual(R.msSetFromDraft({ thinking: {}, noThinking: {} }, { presencePenalty: 1.5 }), { presencePenalty: 1.5 });
});

test("main builds the agent calls and refuses an id that is not one", () => {
  assert.deepEqual(M.samplingArgs("qwen-3.5-4b"), ["models", "sampling", "qwen-3.5-4b", "--json"]);
  assert.deepEqual(M.samplingArgs("qwen-3.5-4b", null), ["models", "sampling", "qwen-3.5-4b", "--reset", "--json"]);
  assert.deepEqual(M.samplingArgs("q", { topK: 2 }), ["models", "sampling", "q", "--set", '{"topK":2}', "--json"]);
  assert.equal(M.samplingArgs("--reset"), null);
  assert.equal(M.samplingArgs("a b"), null);
});

test("main reads the report, an older agent, and the agent's own reason", () => {
  assert.deepEqual(M.samplingAnswerFrom({ ok: true, stdout: JSON.stringify(report) + "\n", stderr: "" }).report, report);
  assert.equal(M.samplingAnswerFrom({ ok: true, stdout: "nope", stderr: "" }).ok, false);
  assert.equal(M.samplingAnswerFrom({ ok: false, stdout: "", stderr: "unknown subcommand: sampling\nUsage..." }).older, true);
  assert.equal(
    M.samplingAnswerFrom({ ok: false, stdout: "", stderr: "models sampling: sampling.topP: 2 is outside the range llama.cpp takes\n" }).error,
    "sampling.topP: 2 is outside the range llama.cpp takes",
  );
});
