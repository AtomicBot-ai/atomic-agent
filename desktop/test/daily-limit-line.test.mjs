// ATO-1544: a turn the daily cloud spending limit (ATO-649) stopped says so in
// plain words (spent, limit, where to change it) instead of "This turn could
// not be completed", and offers Switch provider. The renderer as text in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

const NAMES = [
  "providerHost", "providerFailure", "providerReplied", "turnWaited", "turnFailureLine", "offlineTurnLine",
  "dailyLimitLine", "turnKeyRejected", "turnFailureAct",
  "selProviders", "selActiveProviderId", "llmBlock", "llmProviders", "llmProvider", "llmLocalModels",
];

const CONFIG = {
  llm: { activeTextProvider: "openrouter", providers: [
    { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  ] },
};

function load() {
  const c = vm.createContext({
    LIVE_CONFIG: CONFIG, S: { turnStartedAt: 0, log: [] }, SWX: {}, projectTurnModel: () => null, URL, DWATCH: null,
    esc: (s) => String(s), providerWord: (id) => (id === "openrouter" ? "OpenRouter" : String(id)),
    savedKeyInvalid: () => false, billingFailureLine: () => "",
  });
  for (const n of NAMES) vm.runInContext(fn(n), c);
  return c;
}

const SAID = "Daily cloud limit reached: $1.20 of $1.00. Cloud calls are paused until tomorrow. "
  + 'Raise llm.costTracking.dailyLimitUsd or set llm.costTracking.onDailyLimit to "local" to use your local model.';

test("the agent's sentence gives the spent amount, the limit and where to change it", () => {
  const c = load();
  const line = c.turnFailureLine({ kind: "error", category: "transport", error: SAID });
  assert.equal(line, "Today's cloud spending limit is reached: $1.20 spent of $1.00. Cloud calls are paused until tomorrow."
    + " Pick a local model to keep going, or raise llm.costTracking.dailyLimitUsd in the agent's config.json.");
  assert.doesNotMatch(line, /not answering|could not be completed/);
});

test("the agent's verdict alone is enough", () => {
  const c = load();
  const ev = { kind: "error", category: "transport", error: "something else",
    payload: { failure: { cause: "daily_limit_reached", action: "switch-model" } } };
  assert.match(c.turnFailureLine(ev), /^Today's cloud spending limit is reached\. Cloud calls are paused until tomorrow\./);
});

test("the row offers Switch provider", () => {
  const c = load();
  assert.equal(c.turnFailureAct({ kind: "error", category: "transport", error: SAID }).act, "switch-provider");
});

test("other failures are left alone", () => {
  const c = load();
  assert.equal(c.dailyLimitLine({ kind: "error", category: "transport", error: "fetch failed" }), "");
  assert.equal(c.dailyLimitLine({ kind: "error", payload: { failure: { cause: "rate_limited" } } }), "");
});
