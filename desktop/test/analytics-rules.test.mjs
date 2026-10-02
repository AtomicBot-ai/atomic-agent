// The desktop analytics rules a review asked for, against the built output
// (npm run build first) and the renderer's analytics scripts in a vm:
// ui_action ids, quant / locale / RAM shapes, the opt-out order, the install
// id order, the inherited opt-out, upgrader seeding, backend_switched, the
// bounded transport and the Sentry envelope. Each test fails if the rule it
// names is removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const V = require("../out/main/analytics/validate.js");
const I = require("../out/main/analytics/identity.js");
const E = require("../out/main/analytics/environment.js");
const S = require("../out/main/sentry/scrub.js");
const CV = require("../out/main/analytics/catalog-values.js");
const OO = require("../out/main/analytics/opt-out.js");
const TR = require("../out/main/analytics/transport.js");
const SU = require("../out/main/analytics/setup.js");
const CORE = require("../out/main/analytics/core.js");
const ENV = require("../out/main/sentry/envelope.js");
const HERE = dirname(fileURLToPath(import.meta.url));

/* ---- ui_action: camelCase in, ids out ---- */

const uiAction = (a) => V.validateEvent("ui_action", { action: a, via: "click" }, "ui").props.action;

test("ui_action accepts the renderer's real camelCase ids", () => {
  for (const a of ["sel:browseLocal", "wiz:useDefault", "mcp:addSubmit", "skills:cardScroll:up", "runmode:workers:4"]) {
    assert.equal(uiAction(a), a);
  }
});

test("ui_action refuses any segment that looks like an id", () => {
  for (const a of [
    "pin:3f2a9c1b", "ses:a1b2c3d4e5", "session:550e8400-e29b-41d4-a716-446655440000", "task:20261002",
    "llm:7", "runmode:workers:9", "runmode:workers:12", "x".repeat(65),
  ]) {
    assert.equal(uiAction(a), undefined, a);
  }
  assert.equal(CV.uiActionOk("theme:dark"), true);
});

/* ---- quant, locale, host_ram_gb ---- */

test("quant is an upper-cased GGUF tag or unknown; locale is dropped unless it looks like one", () => {
  const d = (q) => V.validateEvent("model_download_started", { quant: q }, "main").props.quant;
  assert.equal(d("q4_k_m"), "Q4_K_M");
  assert.equal(d("bf16"), "BF16");
  assert.equal(d("my-secret-repo"), "unknown");
  assert.equal(d(42), "unknown");
  const loc = (l) => V.validateEvent("voice_used", { action: "start", result: "ok", locale: l }, "main").props.locale;
  assert.equal(loc("en-US"), "en-US");
  assert.equal(loc("yue"), "yue");
  assert.equal(loc("EN_us"), undefined);
  assert.equal(loc(null), null);
});

test("model_picked.host_ram_gb is a string bucket or null; a number is dropped", () => {
  const p = (v) => V.validateEvent("model_picked", { model_id: "nope/secret-repo", host_ram_gb: v }, "ui").props;
  assert.equal(p("16").host_ram_gb, "16");
  assert.equal(p(null).host_ram_gb, null);
  assert.equal("host_ram_gb" in p(16), false);
  assert.equal(p("16").model_id, "custom");
});

test("onboarding steps accept `other`", () => {
  assert.equal(V.validateEvent("onboarding_skipped", { at_step: "other" }, "ui").props.at_step, "other");
  assert.equal(V.validateEvent("onboarding_step", { step: "other", prev_step: "other" }, "ui").props.prev_step, "other");
});

test("model_configured takes the runtime's llama.cpp; dead values are gone", () => {
  assert.equal(V.validateEvent("model_configured", { provider: "llama.cpp", kind: "local" }, "main").props.provider, "llama.cpp");
  assert.equal("result" in V.validateEvent("provider_key_checked", { result: "saved_unchecked" }, "main").props, false);
  assert.equal(V.validateEvent("agent_restarted", { trigger: "update" }, "main").props.trigger, "other");
  assert.equal("step" in V.validateEvent("telegram_setup", { step: "pair", result: "ok" }, "main").props, false);
});

/* ---- the renderer's half, run in a vm ---- */

function loadRenderer() {
  const sent = [];
  const ctx = vm.createContext({
    window: { atomic: { track: (event, props) => sent.push({ event, props }) }, addEventListener() {} },
    setTimeout, clearTimeout, Date,
  });
  for (const f of ["analytics-acts.js", "analytics.js"]) {
    vm.runInContext(readFileSync(join(HERE, "..", "renderer", f), "utf8"), ctx, { filename: f });
  }
  return { ANX: vm.runInContext("ANX", ctx), sent };
}

test("renderer: host_ram_gb is sent as the string bucket, model_id as the row's real id", () => {
  const { ANX, sent } = loadRenderer();
  assert.equal(ANX.ramBucket(12), "8");
  assert.equal(ANX.ramBucket(13), "16");
  assert.equal(ANX.ramBucket(48), "32");
  assert.equal(ANX.ramBucket(64), "64");
  assert.equal(ANX.ramBucket(0), null);
  ANX.modelPicked({ id: "qwen3-8b" }, { v: "tight", known: false }, 16, 4.96);
  assert.deepEqual({ ...sent[0].props }, { model_id: "qwen3-8b", size_gb: 5, fit: "tight", host_ram_gb: "16" });
});

test("renderer: a keyboard marker is reported as a shortcut", () => {
  const { ANX } = loadRenderer();
  ANX.via("key");
  assert.equal(ANX.viaNow(), "shortcut");
});

/* ---- opt-out order ---- */

function fakeSwitch(log, { now = true, files = false } = {}) {
  return {
    enabledNow: () => now,
    enabledInFiles: () => files,
    announceDisabled: (via) => log.push(`announce:${via}`),
    flush: async () => { log.push("flush"); },
    setEnabled: (on) => log.push(`set:${on}`),
  };
}

test("opt-out: write first, then analytics_disabled, flush, and only then the switch", async () => {
  const log = [];
  const res = await OO.writeAnalyticsSwitch("analytics.enabled", "false", "slash",
    async () => { log.push("write"); return { ok: true }; }, fakeSwitch(log));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(log, ["write", "announce:slash", "flush", "set:false"]);
});

test("opt-out: a failed write announces nothing and changes nothing", async () => {
  const log = [];
  await OO.writeAnalyticsSwitch("analytics.enabled", "false", "settings",
    async () => { log.push("write"); return { ok: false, error: "locked" }; }, fakeSwitch(log));
  assert.deepEqual(log, ["write"]);
});

test("opt-in: the switch follows a successful write, nothing announced", async () => {
  const log = [];
  await OO.writeAnalyticsSwitch("analytics.enabled", "true", "settings",
    async () => { log.push("write"); return { ok: true }; }, fakeSwitch(log, { now: false, files: true }));
  assert.deepEqual(log, ["write", "set:true"]);
});

/* ---- identity order, gate, upgraders ---- */

test("install id: the terminal agent's id wins over the desktop's, unless the terminal opted out", () => {
  const root = mkdtempSync(join(tmpdir(), "aa-order-"));
  const tui = join(root, "tui"), desk = join(root, "desk");
  mkdirSync(tui); mkdirSync(desk);
  writeFileSync(join(tui, "analytics.json"), JSON.stringify({ installId: "11111111-1111-4111-8111-111111111111" }));
  writeFileSync(join(desk, "analytics.json"), JSON.stringify({ installId: "22222222-2222-4222-8222-222222222222" }));
  const shared = join(root, "shared-id");
  const r1 = I.resolveInstallId({ sharedPath: shared, localFiles: CORE.installIdSources(tui, desk, false), allowWrite: true });
  assert.equal(r1.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(readFileSync(shared, "utf8").trim(), r1.id);
  const r2 = I.resolveInstallId({ sharedPath: join(root, "other"), localFiles: CORE.installIdSources(tui, desk, true), allowWrite: false });
  assert.equal(r2.id, "22222222-2222-4222-8222-222222222222");
});

test("gate: an opt-out in the terminal config is inherited only when the desktop says nothing", () => {
  const off = { analytics: { enabled: false } };
  assert.equal(E.analyticsEnabledFor({}, off), false);
  assert.equal(E.analyticsEnabledFor(undefined, off), false);
  assert.equal(E.analyticsEnabledFor({ analytics: { enabled: true } }, off), true);
  assert.equal(E.analyticsEnabledFor({}, {}), true);
  assert.equal(E.inheritedOptOut({}, off), true);
});

test("test and dev runs: --dev, NODE_ENV=development and unpackaged builds send nothing", () => {
  assert.equal(E.isTestRun(["electron", "."], {}, true), false);
  assert.equal(E.isTestRun(["electron", ".", "--dev"], {}, true), true);
  assert.equal(E.isTestRun(["electron", "."], { NODE_ENV: "development" }, true), true);
  assert.equal(E.isTestRun(["electron", "."], {}, false), true);
  assert.equal(E.isTestRun(["electron", "."], { ATOMIC_DESKTOP_ANALYTICS: "on" }, false), false);
});

test("upgraders: no flags file on a used state dir means no install date and no first model_configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-seed-"));
  const up = join(dir, "up.json");
  I.seedDesktopFlags(new I.DesktopFlagsStore(up, () => true), false, 5_000);
  const again = new I.DesktopFlagsStore(up, () => true);
  assert.equal(again.get().modelConfiguredSent, true);
  assert.equal(again.get().installedAt, null);
  const fresh = new I.DesktopFlagsStore(join(dir, "fresh.json"), () => true);
  I.seedDesktopFlags(fresh, true, 5_000);
  assert.equal(fresh.get().installedAt, 5_000);
  assert.equal(fresh.get().modelConfiguredSent, false);
  I.seedDesktopFlags(again, true, 9_000);   // an existing file is never reseeded
  assert.equal(again.get().installedAt, null);
});

/* ---- backend_switched ---- */

test("backend_switched: explicit switches and real mode changes only", () => {
  assert.equal(SU.shouldReportSwitch(undefined, "cloud", "cloud"), false);
  assert.equal(SU.shouldReportSwitch({ action: "pick_worker_model" }, "fusion", "fusion"), false);
  assert.equal(SU.shouldReportSwitch(undefined, "cloud", "local"), true);
  assert.equal(SU.shouldReportSwitch({ explicit: true }, "cloud", "cloud"), true);
});

/* ---- transport ---- */

test("flush is bounded as a whole, a batch still on the wire included", async () => {
  const t = new TR.PostHogTransport({ canSend: () => true, distinctId: () => "id", fetchImpl: () => new Promise(() => {}) });
  t.enqueue("app_opened", {});
  const t0 = Date.now();
  await t.flush(60);
  t.enqueue("app_closed", {});
  await t.flush(60);   // the first batch never answers: this one must not wait for it
  assert.ok(Date.now() - t0 < 1_000);
});

test("the quit drains several batches", async () => {
  let calls = 0;
  const t = new TR.PostHogTransport({ canSend: () => true, distinctId: () => "id", fetchImpl: async () => { calls++; return {}; } });
  for (let i = 0; i < 250; i++) t.enqueue("ui_action", {});
  await t.flush(2_000, 5);
  assert.equal(calls, 3);
});

/* ---- Sentry ---- */

test("error types: Error/Exception names and the shell's own, else Error", () => {
  assert.equal(S.safeType("NonError"), "NonError");
  assert.equal(S.safeType("AbortError"), "AbortError");
  assert.equal(S.safeType("secret_value"), "Error");
  assert.equal(S.safeType("Alice"), "Error");
});

test("a message line that looks like a frame is never read as one", () => {
  const message = "boom\n    at leak (/Users/alice/secret.js:1:2)";
  const stack = `Error: ${message}\n    at real (/app/out/main/main.js:3:4)`;
  assert.deepEqual(S.sanitizeStack(stack, message), [{ function: "real", filename: "main.js", lineno: 3, colno: 4 }]);
});

test("every envelope is platform node and tells Sentry not to infer the IP", () => {
  const dsn = ENV.parseDsn("https://key@o1.ingest.sentry.io/42");
  const { body } = ENV.buildEnvelope(dsn, { type: "Error", frames: [], release: "atomic-agent-desktop@1.0.0", sdkVersion: "1.0.0", installId: "id", tags: {} });
  const event = JSON.parse(body.trim().split("\n")[2]);
  assert.equal(event.platform, "node");
  assert.deepEqual(event.sdk.settings, { infer_ip: "never" });
  assert.equal(event.user.ip_address, null);
  assert.equal("minidumpUrl" in dsn, false);
});
