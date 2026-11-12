// ATO-1458 / ATO-1459: a turn that failed on a refused key gets a "Check key"
// button on its line (Settings › Models on that provider, the caret in its key
// field); a fallback that answered gets "Fallback settings" (Settings › Models
// › Fallback chain). The key is recognised by the agent's verdict
// (`failure.cause` / `failure.action`, ATO-384), with the agent's sentence as
// the fallback for older agents.
// The renderer as text in a vm.
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
  "providerHost", "providerFailure", "providerReplied", "turnWaited", "turnFailureLine",
  "turnKeyRejected", "turnFailureAct", "sysRowHTML",
  "selProviders", "selActiveProviderId", "llmBlock", "llmProviders", "llmProvider", "llmLocalModels",
];

const CONFIG = {
  llm: { activeTextProvider: "openrouter", providers: [
    { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  ] },
};

function load(opts = {}) {
  const c = vm.createContext({
    LIVE_CONFIG: CONFIG, S: { turnStartedAt: 0, log: [] }, SWX: {}, URL, DWATCH: null,
    esc: (s) => String(s), providerWord: (id) => (id === "openrouter" ? "OpenRouter" : String(id)),
    savedKeyInvalid: () => !!opts.badSavedKey, billingFailureLine: () => "",
    ic: () => "", sysGlyph: () => "", sysRetryHTML: () => "", sysDetailHTML: () => "", tpTriedHTML: () => "",
    deadEngineOffer: () => ({ kind: "" }), deadEngineActHTML: () => "",
  });
  for (const n of NAMES) vm.runInContext(fn(n), c);
  return c;
}

const verdict = { kind: "error", category: "provider", error: "openrouter provider 401: {\"error\":\"nope\"}",
  payload: { failure: { cause: "auth_rejected", phrase: "The provider did not accept your API key.", action: "fix-key" } } };

test("the agent's verdict alone gives one line and Check key on the picked provider", () => {
  const c = load();
  assert.equal(c.turnFailureLine(verdict), "OpenRouter did not accept the API key.");
  const a = c.turnFailureAct(verdict);
  assert.equal(a.act, "fix-key");
  assert.equal(a.keyFor, "openrouter");
  const html = c.sysRowHTML({ id: 1, k: "system", sev: "err", text: "x", ...a }, 1);
  assert.match(html, /data-act="llm:checkKey:openrouter">Check key<\/button>/);
  assert.doesNotMatch(html, /Switch provider/);
});

test("an older agent's sentence still gets the button", () => {
  const c = load();
  const ev = { kind: "error", category: "provider", error: "OpenRouter rejected the API key (401). Check the key in the Providers panel." };
  assert.equal(c.turnFailureLine(ev), "OpenRouter rejected the API key (401). Check the key in Settings › Models.");
  assert.equal(c.turnFailureAct(ev).act, "fix-key");
  assert.equal(c.turnFailureAct({ kind: "error", payload: { failure: { cause: "x", action: "fix-key" } } }).act, "fix-key");
});

test("a saved key the agent will not send gets the button too", () => {
  const c = load({ badSavedKey: true });
  assert.equal(c.turnFailureAct({ kind: "error", error: "fetch failed", category: "transport" }).act, "fix-key");
});

test("any other failure keeps its old button", () => {
  const c = load();
  const ev = { kind: "error", category: "transport", error: "fetch failed", payload: { failure: { cause: "connection_refused", action: "retry" } } };
  assert.notEqual(c.turnFailureAct(ev).act, "fix-key");
  assert.equal(c.turnFailureAct({ kind: "error", category: "model", error: "bad json" }).act, null);
});

test("Fallback settings is drawn on a fallback line", () => {
  const c = load();
  const html = c.sysRowHTML({ id: 2, k: "system", note: true, text: "OpenRouter is rate-limited, switched to Gemini.", act: "fallback-settings" }, 1);
  assert.match(html, /data-act="llm:fbOpen">Fallback settings<\/button>/);
});

test("both failed-turn rows take the button from turnFailureAct, and the buttons open the right Settings screens", () => {
  assert.equal(source.split("...turnFailureAct(ev), ...deadEngineRow(ev)}").length - 1, 2);
  const llmAct = fn("llmAct");
  assert.match(llmAct, /verb === 'checkKey'\) \{\n\s+act\('settings:llm'\);[\s\S]*?llmOpenWizard\(p\); wizFocusKey\(\);/);
  assert.match(llmAct, /verb === 'fbOpen'\) \{ act\('settings:llm'\); llmSetMode\('fallback'\);/);
});
