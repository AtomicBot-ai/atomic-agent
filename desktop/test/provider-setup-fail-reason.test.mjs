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

// ATO-1195: list_failed split by what went wrong on our side, and the
// provider's type on the event.
test("our own failures have their own reasons", () => {
  assert.equal(reason({ ok: false, failure: "agent_crashed", error: "Assertion failed: x" }), "agent_crashed");
  assert.equal(reason({ ok: false, failure: "not_json", error: 'models search did not return JSON: "oops"' }), "not_json");
  assert.equal(reason({ ok: false, failure: "no_binary", error: "no atomic-agent binary found" }), "no_binary");
  // the provider's own answer still comes first
  assert.equal(reason({ ok: false, status: 401, failure: "agent_crashed" }), "key_rejected");
  assert.equal(reason({ ok: false, unreachable: true, failure: "agent_crashed" }), "server_unreachable");
});

test("providerModels says which of our failures it was", async () => {
  const require = createRequire(import.meta.url);
  const { providerModels, withCliStandIn } = require("../out/main/agent-cli.js");
  const run = (answer) => withCliStandIn(async () => answer, () => providerModels("deepseek", "deepseek"));
  const crashed = await run({ ok: false, stdout: "", exitCode: 134,
    stderr: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76",
    error: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76" });
  assert.equal(crashed.failure, "agent_crashed");
  assert.equal((await run({ ok: true, stdout: "not a list", stderr: "" })).failure, "not_json");
  assert.equal((await run({ ok: false, stdout: "", stderr: "", error: "no atomic-agent binary found" })).failure, "no_binary");
  const refused = await run({ ok: false, stdout: "", stderr: "", exitCode: 1, error: 'could not list models from "deepseek": http 401' });
  assert.equal(refused.status, 401);
  assert.equal(refused.failure, undefined);
  const empty = await run({ ok: true, stdout: "[]", stderr: "" });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.models, []);
});

test("the catalogue takes the split reasons and the provider type", () => {
  const require = createRequire(import.meta.url);
  const V = require("../out/main/analytics/validate.js");
  for (const r of ["agent_crashed", "not_json", "no_binary"]) {
    const v = V.validateEvent("provider_setup_failed", { step: "onboarding", reason: r, provider_preset: "deepseek", kind: "cloud" }, "ui");
    assert.deepEqual(v.props, { step: "onboarding", reason: r, provider_preset: "deepseek", kind: "cloud" });
  }
});

// Review round: provider_setup_failed.kind must agree with model_configured's
// kind for the same provider (ATO-816: an app the user runs, such as Ollama,
// LM Studio or Atomic Chat, is Custom, like a custom URL). Both sides run
// for real: the wizard's ANX.providerFailed (renderer/analytics.js in a vm)
// and setup.ts configuredRoute over a config.json naming the same provider.
test("the wizard and model_configured give one provider the same kind", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const SU = require("../out/main/analytics/setup.js");
  const { LOCAL_APP_PRESETS } = require("../out/main/analytics/catalog-values.js");

  const sent = [];
  const noop = () => {};
  const rctx = vm.createContext({
    window: { atomic: { track: (event, props) => sent.push({ event, props }) }, addEventListener: noop },
    setTimeout, clearTimeout,
  });
  const dir = new URL("../renderer/", import.meta.url);
  vm.runInContext(readFileSync(new URL("analytics-acts.js", dir), "utf8")
    + "\n" + readFileSync(new URL("analytics.js", dir), "utf8") + "\n;globalThis.__ANX = ANX;", rctx);
  const wizardKind = (row) => {
    sent.length = 0;
    rctx.__ANX.providerFailed("list_failed", true, row);
    return sent.find((s) => s.event === "provider_setup_failed").props.kind;
  };
  const configuredKind = (provider) => {
    const stateDir = mkdtempSync(join(tmpdir(), "kind-"));
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({
      llm: { activeTextProvider: provider.id, providers: [{ id: provider.id, kind: provider.kind }] },
    }));
    SU.configureSetup({ stateDir });
    return SU.configuredRoute().kind;
  };

  // the wizard's own rows, read from renderer.js: every local:true row is a LOCAL_APP_PRESETS id
  const localIds = [...source.matchAll(/\{id:'([\w.-]+)'[^}]*\blocal:true\b/g)].map((m) => m[1]).sort();
  assert.deepEqual(localIds, [...LOCAL_APP_PRESETS].sort());

  for (const id of LOCAL_APP_PRESETS) {
    const row = { id, kind: "openai-compatible", local: true };
    assert.equal(wizardKind(row), "custom", id);
    assert.equal(configuredKind(row), "custom", id);
  }
  const cloud = { id: "deepseek", kind: "deepseek" };
  assert.equal(wizardKind(cloud), "cloud");
  assert.equal(configuredKind(cloud), "cloud");
  const custom = { id: "openai-compatible", kind: "openai-compatible", custom: true };
  assert.equal(wizardKind(custom), "custom");
  assert.equal(configuredKind({ id: "my-proxy", kind: "openai-compatible" }), "custom");
});
