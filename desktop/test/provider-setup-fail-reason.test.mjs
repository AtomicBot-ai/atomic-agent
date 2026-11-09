// ATO-306: provider_setup_failed said `catalog_empty` for every failed model
// list that was not a dead server, a certificate or our deadline. A refused
// key, a provider's 429/5xx and a list the agent printed and then died at
// exit (#902) all read as "empty catalogue", and the event carried no
// provider, so 53 Windows people could not be told apart.
//
// wizSetupFailReason runs in a vm context from renderer.js as text; the
// catalog check runs against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

const ctx = vm.createContext({});
vm.runInContext(fn("wizSaidNoModels") + fn("wizSetupFailReason"), ctx);
const reason = (listed) => ctx.wizSetupFailReason(listed);

const EMPTY_LINE = "no searchable cloud models: the configured providers ship no catalog.";

test("a list that came back empty, or the agent saying so, is an empty catalogue", () => {
  assert.equal(reason({ ok: true, models: [] }), "catalog_empty");
  assert.equal(reason({ ok: false, error: EMPTY_LINE }), "catalog_empty");
});

test("a refused key is not an empty catalogue", () => {
  assert.equal(reason({ ok: false, status: 401, error: 'could not list models from "deepseek": http 401' }), "key_rejected");
  assert.equal(reason({ ok: false, status: 403, error: "http 403" }), "key_rejected");
});

test("a provider's own trouble is a provider error", () => {
  assert.equal(reason({ ok: false, status: 429, error: "http 429" }), "provider_error");
  assert.equal(reason({ ok: false, status: 503, error: "http 503" }), "provider_error");
});

test("a list that failed otherwise, or no answer at all, is list_failed", () => {
  const assertion = "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76";
  assert.equal(reason({ ok: false, error: assertion }), "list_failed");
  assert.equal(reason({ ok: false, error: 'models search did not return JSON: "oops"' }), "list_failed");
  assert.equal(reason(null), "list_failed");
  assert.equal(reason({ ok: false }), "list_failed");
});

test("the earlier reasons keep their place", () => {
  assert.equal(reason({ ok: false, certificate: "self-signed", status: 401 }), "certificate");
  assert.equal(reason({ ok: false, timedOut: true }), "timed_out");
  assert.equal(reason({ ok: false, unreachable: true, error: "fetch failed" }), "server_unreachable");
});

test("the wizard reports the reason and the row", () => {
  const at = source.indexOf("\nasync function wizNextStep(");
  const body = source.slice(at, source.indexOf("\n}\n", at));
  assert.match(body, /ANX\.providerFailed\(wizSetupFailReason\(listed\), OB\.open, k\)/);
});

test("the catalogue accepts the new reasons and the preset", () => {
  const require = createRequire(import.meta.url);
  const V = require("../out/main/analytics/validate.js");
  for (const r of ["key_rejected", "provider_error", "list_failed", "catalog_empty"]) {
    const v = V.validateEvent("provider_setup_failed", { step: "onboarding", reason: r, provider_preset: "ollama" }, "ui");
    assert.deepEqual(v.props, { step: "onboarding", reason: r, provider_preset: "ollama" });
  }
  const custom = V.validateEvent("provider_setup_failed", { step: "settings", reason: "list_failed", provider_preset: "my-proxy" }, "ui");
  assert.equal(custom.props.provider_preset, "custom");
});
