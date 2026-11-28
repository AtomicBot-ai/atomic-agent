// Unit tests for renderer/provider-refusal-line.js (ATO-1673).
// Run: npm run test:unit
// A cloud provider that answered with a refusal opens with what the refusal
// is, in plain words and with no HTTP status; the agent's sentence (with the
// status) stays under Details, which renderer.js turnFailure keeps. Before,
// every such row read "Couldn't get a reply from OpenRouter."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const R = createRequire(import.meta.url)("../renderer/provider-refusal-line.js");

/** The failed turn's frame as the desktop holds it: the agent's sentence and its catalog verdict. */
const frame = (error, cause) => ({
  kind: "error",
  error,
  category: "transport",
  payload: { error, category: "transport", failure: { cause, phrase: "x", action: "switch-model" } },
});

test("each cloud refusal opens with what it is, named after the provider, with no status", () => {
  const cases = [
    ['"openrouter" rejected the request (402). This request requires more credits.', "out_of_credit", /^OpenRouter says your account is out of credit\. Top up your balance with OpenRouter/],
    ['"openrouter" is rate-limiting this key (429).', "rate_limited", /^OpenRouter says there are too many requests right now\. Try again in a moment\.$/],
    ['"openrouter" answered 404 (not found).', "model_not_found", /^OpenRouter doesn't have this model\. Pick another model in Settings › Models\.$/],
    ['"openrouter" rejected the request (400).', "request_rejected", /^OpenRouter turned down this request\./],
  ];
  for (const [error, cause, want] of cases) {
    const line = R.providerRefusalLine(frame(error, cause), "OpenRouter", false);
    assert.match(line, want, cause);
    assert.doesNotMatch(line, /\(\d{3}\)|\b[1-5]\d\d\b/, cause);
    assert.doesNotMatch(line, /Couldn't get a reply/, cause);
    assert.doesNotMatch(line, /\u2014/, cause);
  }
});

test("a cloud model without tools says so, whatever cause the catalog filed it under", () => {
  const said = '"openrouter" says this model can\'t use tools (404), and the agent needs them to work. Pick a model that supports tool calling.';
  const line = R.providerRefusalLine(frame(said, "model_not_found"), "OpenRouter", false);
  assert.equal(line, "OpenRouter says this model can't use tools, and the agent needs them to work. Pick a model that supports tool calling in Settings › Models.");
});

test("no provider name falls back to 'The provider'", () => {
  assert.match(R.providerRefusalLine(frame("(429)", "rate_limited"), "", false), /^The provider says there are too many requests/);
});

test("a local route, another cause or no verdict keeps the old row", () => {
  assert.equal(R.providerRefusalLine(frame("llama-server returned http 404: not found", "model_not_found"), "Local model", true), "");
  assert.equal(R.providerRefusalLine(frame("x (503)", "provider_trouble"), "OpenRouter", false), "");
  assert.equal(R.providerRefusalLine(frame("x (401)", "auth_rejected"), "OpenRouter", false), "");
  assert.equal(R.providerRefusalLine(frame("x", "toString"), "OpenRouter", false), "");
  assert.equal(R.providerRefusalLine({ kind: "error", error: "x (404)", category: "transport" }, "OpenRouter", false), "");
  assert.equal(R.providerRefusalLine(null, "OpenRouter", false), "");
});

test("renderer.js asks for the refusal line before 'Couldn't get a reply', and index.html loads it first", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function turnFailure(ev)"), src.indexOf("function localWrongServerLine("));
  const hook = body.indexOf("providerRefusalLine(ev,");
  assert.ok(hook > 0, "turnFailure calls providerRefusalLine");
  assert.ok(hook < body.indexOf("Couldn't get a reply from "), "before the old headline");
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const tag = html.indexOf('<script src="provider-refusal-line.js"></script>');
  assert.ok(tag > 0 && tag < html.indexOf('<script src="renderer.js"></script>'), "loaded before renderer.js");
});
