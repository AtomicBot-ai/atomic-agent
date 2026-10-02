// Unit tests for main/analytics and main/sentry, against the built output
// (npm run build first). Pure modules only: the validator, the install id,
// the classifiers, the turn tracker and the error scrubber.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const V = require("../out/main/analytics/validate.js");
const I = require("../out/main/analytics/identity.js");
const C = require("../out/main/analytics/classify.js");
const T = require("../out/main/analytics/chat-turns.js");
const E = require("../out/main/analytics/environment.js");
const S = require("../out/main/sentry/scrub.js");

/* ---- validator ---- */

test("unknown events are dropped, unknown props are dropped", () => {
  assert.equal(V.validateEvent("not_an_event", {}, "main"), null);
  const v = V.validateEvent("task_created", { kind: "cron", message: "secret prompt" }, "main");
  assert.deepEqual(v, { event: "task_created", props: { kind: "cron" } });
});

test("the renderer may only send UI-owned events", () => {
  assert.equal(V.validateEvent("app_opened", { launch_kind: "cold" }, "ui"), null);
  assert.ok(V.validateEvent("slash_command_used", { command: "help" }, "ui"));
});

test("enum values outside the list become `other`, or the prop's fallback, or are dropped", () => {
  assert.deepEqual(V.validateEvent("message_action", { action: "nope" }, "ui").props, {});
  assert.deepEqual(V.validateEvent("agent_restarted", { trigger: "weird" }, "main").props, { trigger: "other" });
  assert.deepEqual(V.validateEvent("slash_command_used", { command: "/rm -rf" }, "ui").props, { command: "unknown" });
  assert.deepEqual(V.validateEvent("provider_setup_started", { provider_preset: "my-own-proxy" }, "ui").props, { provider_preset: "custom" });
});

test("strings must be short and identifier-shaped", () => {
  assert.deepEqual(V.validateEvent("voice_used", { action: "start", result: "ok", locale: "en-US" }, "main").props,
    { action: "start", result: "ok", locale: "en-US" });
  assert.deepEqual(V.validateEvent("voice_used", { action: "start", result: "ok", locale: "/Users/me" }, "main").props,
    { action: "start", result: "ok" });
  assert.equal(V.safeString("x".repeat(65)), undefined);
});

test("ui_action keeps prefix[:tail[:tail]] and drops anything else", () => {
  const ok = (a) => V.validateEvent("ui_action", { action: a, via: "click" }, "ui").props.action;
  assert.equal(ok("settings:privacy"), "settings:privacy");
  assert.equal(ok("runmode:workers:4"), "runmode:workers:4");
  assert.equal(ok("pin:abc:def:ghi"), undefined);
  assert.equal(ok("Pin"), undefined);
  assert.equal(ok("open:/Users/me"), undefined);
});

test("numbers are clamped and nulls only pass where allowed", () => {
  const p = V.validateEvent("fusion_configured", { action: "set_workers", workers: 99, degraded: false }, "main").props;
  assert.equal(p.workers, 8);
  assert.deepEqual(V.validateEvent("approval_answered", { choice: "deny", category: "shell", input: "key", ms_to_answer: null }, "ui").props.ms_to_answer, null);
  assert.equal("ms" in V.validateEvent("llama_runtime_updated", { trigger: "setup", result: "ok", ms: null }, "main").props, false);
});

test("tool lists keep built-in names; every MCP tool is `mcp`", () => {
  const p = V.validateEvent("chat_turn_ui", { outcome: "completed", ms_total: 5, tools_used: ["os.fs.read", "mcp.github.create_issue", "mcp.slack.post", "Bad Name", "os.fs.read"] }, "main").props;
  assert.deepEqual(p.tools_used, ["os.fs.read", "mcp"]);
});

test("import parts and counts keep only the known keys", () => {
  const p = V.validateEvent("import_run", {
    source: "tui", result: "ok",
    parts: { providers: true, keys: false, secretPath: true },
    counts: { providers: 2, memory: true, sessions: -4 },
  }, "main").props;
  assert.deepEqual(p.parts, { providers: true, keys: false });
  assert.deepEqual(p.counts, { providers: 2, sessions: 0, memory: 1 });
});

/* ---- install id ---- */

test("install id: a valid shared file wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-id-"));
  const shared = join(dir, "id");
  writeFileSync(shared, "11111111-2222-4333-8444-555555555555\n");
  const r = I.resolveInstallId({ sharedPath: shared, localFiles: [], allowWrite: true });
  assert.deepEqual(r, { id: "11111111-2222-4333-8444-555555555555", source: "shared" });
});

test("install id: a local analytics.json id is adopted and written to the shared file", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-id-"));
  const shared = join(dir, "sub", "id");
  const local = join(dir, "analytics.json");
  writeFileSync(local, JSON.stringify({ installId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
  const r = I.resolveInstallId({ sharedPath: shared, localFiles: [join(dir, "missing.json"), local], allowWrite: true });
  assert.equal(r.source, "local");
  assert.equal(readFileSync(shared, "utf8").trim(), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test("install id: minted when nothing exists; nothing written when writes are not allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-id-"));
  const shared = join(dir, "id");
  writeFileSync(shared, "not a uuid");
  const r = I.resolveInstallId({ sharedPath: shared, localFiles: [], allowWrite: false, mint: () => "99999999-9999-4999-8999-999999999999" });
  assert.deepEqual(r, { id: "99999999-9999-4999-8999-999999999999", source: "minted" });
  assert.equal(readFileSync(shared, "utf8"), "not a uuid");
  const fresh = join(dir, "fresh");
  I.resolveInstallId({ sharedPath: fresh, localFiles: [], allowWrite: false });
  assert.equal(existsSync(fresh), false);
});

test("install id: the env override names the shared file", () => {
  assert.equal(I.sharedIdPath({ ATOMIC_AGENT_INSTALL_ID_FILE: "/x/id" }, "/home/me"), "/x/id");
  assert.equal(I.sharedIdPath({}, "/home/me"), join("/home/me", ".atomic-agent-install-id"));
});

test("desktop flags persist and days_since_install counts whole days", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-flags-"));
  const path = join(dir, "desktop-analytics.json");
  const a = new I.DesktopFlagsStore(path, () => true);
  a.set({ installedAt: 1_000, modelConfiguredSent: true });
  const b = new I.DesktopFlagsStore(path, () => true);
  assert.equal(b.get().modelConfiguredSent, true);
  assert.equal(I.daysSince(0, 3 * 86_400_000 + 5), 3);
  assert.equal(I.daysSince(null), undefined);
});

/* ---- environment ---- */

test("install channel per platform", () => {
  assert.equal(E.installChannelFor("darwin", {}), "dmg");
  assert.equal(E.installChannelFor("win32", {}), "exe");
  assert.equal(E.installChannelFor("linux", { APPIMAGE: "/tmp/a.AppImage" }), "appimage");
  assert.equal(E.installChannelFor("linux", {}), "deb");
});

test("analytics.enabled: absent is on, false is off, an unreadable file is off", () => {
  assert.equal(E.analyticsEnabledIn(undefined), true);
  assert.equal(E.analyticsEnabledIn({}), true);
  assert.equal(E.analyticsEnabledIn({ analytics: { enabled: false } }), false);
  assert.equal(E.analyticsEnabledIn(null), false);
});

/* ---- classifiers ---- */

test("classifiers map to the catalogue's enums", () => {
  assert.equal(C.ramBucket(12), "8");
  assert.equal(C.ramBucket(36), "32");
  assert.equal(C.fitFor(16, { minRamGb: 6, recommendedRamGb: 8 }), "comfortable");
  assert.equal(C.fitFor(16, { minRamGb: 12, recommendedRamGb: 24 }), "tight");
  assert.equal(C.fitFor(8, { sizeGb: 20 }), "over");
  assert.equal(C.quantOf("models/Qwen3-8B-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(C.quantOf("x-UD-Q4_K_XL.gguf"), "UD-Q4_K_XL");
  assert.equal(C.quantOf("weights.gguf"), "unknown");
  assert.deepEqual(C.keyCheckResult({ ok: false, checked: true, status: 401 }), { result: "rejected", http_status: 401 });
  assert.deepEqual(C.keyCheckResult({ ok: false, checked: false }), { result: "unreachable", http_status: null });
  assert.equal(C.hfLookupResult("Hugging Face returned 403: either no such repo, or it is gated."), "gated");
  assert.equal(C.hfLookupResult("No .gguf files in a/b"), "no_gguf");
  assert.equal(C.downloadFailReason("ENOSPC: no space left on device", true), "disk_full");
  assert.equal(C.downloadFailReason("something", false), "no_progress");
  assert.deepEqual(C.switchOutcome({ ok: false, needsKey: true, keyInvalid: true }), { result: "refused", refusal: "key_invalid" });
  assert.equal(C.presetOf("openrouter"), "openrouter");
  assert.equal(C.presetOf("my-corp-gateway"), "custom");
});

/* ---- chat turns ---- */

test("a turn's summary: first token, tools, steers, approvals, failure category", () => {
  let now = 0;
  const out = [];
  const t = new T.ChatTurnTracker((s) => out.push(s), () => now);
  t.setCodingMode("plan");
  t.begin("t1", 40);
  t.observe({ turnId: "t1", kind: "session_id", payload: { session_id: "s1" } });
  now = 100;
  t.observe({ turnId: "t1", kind: "tool_progress", payload: { tool: "os.shell.run", session_id: "s1" } });
  t.observe({ turnId: "t1", kind: "tool_progress", payload: { tool: "mcp.myserver.secret_tool" } });
  t.approval({ sessionId: "s1", tool: "os.shell.run" });
  t.observe({ turnId: "t1", kind: "steer_applied", text: "do it differently" });
  now = 250;
  t.observe({ turnId: "t1", kind: "delta", text: "hello" });
  t.observe({ turnId: "t1", kind: "error", error: "boom", category: "transport", payload: {} });
  now = 400;
  t.observe({ turnId: "t1", kind: "done" });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    outcome: "failed", ms_to_first_token: 250, ms_total: 400, queue_wait_ms: 40, steer_count: 1,
    approvals_asked: 1, tool_calls: 2, tools_used: ["os.shell.run", "mcp"], error_category: "transport", coding_mode: "plan",
  });
});

test("work after an error frame completes the turn", () => {
  const out = [];
  const t = new T.ChatTurnTracker((s) => out.push(s));
  t.begin("t2");
  t.observe({ turnId: "t2", kind: "error", error: "step failed", category: "tool", payload: {} });
  t.observe({ turnId: "t2", kind: "delta", text: "recovered" });
  t.observe({ turnId: "t2", kind: "done" });
  assert.equal(out[0].outcome, "completed");
  assert.equal(out[0].error_category, null);
});

/* ---- error scrubber ---- */

test("stacks keep basenames, line, column and function only", () => {
  const stack = [
    "TypeError: cannot read /Users/alice/secret.txt",
    "    at readThing (/Users/alice/dev/atomic/desktop/out/main/main.js:12:34)",
    "    at async Promise.all (index 0)",
    "    at file:///Applications/Atomic%20Agent.app/Contents/Resources/app.asar/out/renderer/renderer.js:99:1",
    "    at C:\\Users\\bob\\AppData\\Local\\Programs\\atomic\\resources\\app.asar\\out\\main\\agent-cli.js:5:6",
    "    at node:internal/process/task_queues:95:5",
  ].join("\n");
  const frames = S.sanitizeStack(stack);
  assert.deepEqual(frames, [
    { function: "readThing", filename: "main.js", lineno: 12, colno: 34 },
    { filename: "renderer.js", lineno: 99, colno: 1 },
    { filename: "agent-cli.js", lineno: 5, colno: 6 },
    { filename: "node:internal/process/task_queues", lineno: 95, colno: 5 },
  ]);
  assert.ok(!JSON.stringify(frames).includes("alice"));
  assert.ok(!JSON.stringify(frames).includes("bob"));
});

test("messages are dropped unless allowlisted; type names are kept when identifier-shaped", () => {
  assert.equal(S.safeMessage("TypeError", "cannot read /Users/alice"), undefined);
  assert.equal(S.safeType("TypeError"), "TypeError");
  assert.equal(S.safeType("Error: /Users/alice"), "Error");
  assert.ok(S.sanitizeStack(Array.from({ length: 50 }, (_, i) => `    at f${i} (/a/b.js:${i + 1}:1)`).join("\n")).length <= S.MAX_FRAMES);
});
