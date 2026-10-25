// Unit tests for main/analytics and main/sentry, against the built output
// (npm run build first). Pure modules only: the validator, the install id,
// the classifiers, the turn tracker and the error scrubber. The privacy and
// ordering rules are in analytics-rules.test.mjs.
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
const CV = require("../out/main/analytics/catalog-values.js");
const SU = require("../out/main/analytics/setup.js");

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

test("the window names only setup finishing and the Telegram tab; anything else it sends is a manual restart (ATO-274, ATO-900)", () => {
  assert.equal(CV.restartTriggerFromWindow("setup_finished"), "setup_finished");
  assert.equal(CV.restartTriggerFromWindow("telegram"), "telegram");
  assert.equal(CV.restartTriggerFromWindow(undefined), "manual");
  assert.equal(CV.restartTriggerFromWindow("import"), "manual");
  assert.equal(CV.restartTriggerFromWindow({}), "manual");
});

test("enum values outside the list become `other`, or the prop's fallback, or are dropped", () => {
  assert.deepEqual(V.validateEvent("message_action", { action: "nope" }, "ui").props, {});
  assert.deepEqual(V.validateEvent("agent_restarted", { trigger: "weird" }, "main").props, { trigger: "other" });
  // ATO-274: setup, a workspace change and an import are not manual restarts.
  for (const trigger of ["setup_finished", "workspace_change", "import", "telegram"]) {
    assert.deepEqual(V.validateEvent("agent_restarted", { trigger }, "main").props, { trigger });
  }
  // ATO-767: the automatic restart after an unexpected exit keeps its own trigger.
  assert.deepEqual(V.validateEvent("agent_restarted", { trigger: "auto" }, "main").props, { trigger: "auto" });
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
  assert.equal(ok("9pin"), undefined);
  assert.equal(ok("open:/Users/me"), undefined);
});

test("numbers are clamped and nulls only pass where allowed", () => {
  const p = V.validateEvent("fusion_configured", { action: "set_workers", workers: 99, degraded: false }, "main").props;
  assert.equal(p.workers, 8);
  assert.deepEqual(V.validateEvent("approval_answered", { choice: "deny", category: "shell", input: "key", ms_to_answer: null }, "ui").props.ms_to_answer, null);
  // ATO-203: a card closed with no answer.
  assert.deepEqual(V.validateEvent("approval_closed", { how: "stopped", category: "shell", level: 3, ms_open: 1200 }, "ui").props,
    { how: "stopped", category: "shell", level: 3, ms_open: 1200 });
  assert.equal("ms" in V.validateEvent("llama_runtime_updated", { trigger: "setup", result: "ok", ms: null }, "main").props, false);
});

test("the local engine is a known value: Atomic Chat Core (the default) and llama.cpp", () => {
  const up = V.validateEvent("llama_runtime_updated", { trigger: "settings", result: "ok", ms: 1200, engine: "atomic-core" }, "main").props;
  assert.equal(up.engine, "atomic-core");
  assert.equal(V.validateEvent("local_backend_started", { via: "launch", result: "started", model_id: "hf_custom", ms: 10, engine: "llama-server" }, "main").props.engine, "llama-server");
  assert.deepEqual(V.validateEvent("engine_recovery_shown", { engine: "atomic-core", stage: "download", via: "launch" }, "main").props, { engine: "atomic-core", stage: "download", via: "launch" });
  // An unknown stage is not invented: the list has no `other`, so the property is dropped.
  assert.equal(V.validateEvent("engine_recovery_shown", { engine: "atomic-core", stage: "melted", via: "launch" }, "main").props.stage, undefined);
  // An unknown via becomes `other`: it is one of the documented values (main.ts noteEngine defaults to it).
  assert.equal(V.validateEvent("engine_recovery_shown", { engine: "atomic-core", stage: "start", via: "telepathy" }, "main").props.via, "other");
  // The agent sends local_engine_failed itself; the desktop's catalog no longer has it, so one failure is never counted twice.
  assert.equal(V.validateEvent("local_engine_failed", { engine: "atomic-core", stage: "download" }, "main"), null);
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
  assert.equal(C.fitFor(16, { minRamGb: 6, recommendedRamGb: 8 }), "comfortable");
  assert.equal(C.fitFor(16, { minRamGb: 12, recommendedRamGb: 24 }), "tight");
  assert.equal(C.fitFor(8, { sizeGb: 20 }), "over");
  assert.equal(C.quantOf("models/Qwen3-8B-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(C.quantOf("x-UD-Q4_K_XL.gguf"), "Q4_K_XL");
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

test("ATO-773: the engine watchdog's log line becomes a fault code, never text", () => {
  assert.equal(C.engineFault("ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory"), "oom");
  assert.equal(C.engineFault("couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 19091"), "port_in_use");
  assert.equal(C.engineFault("llama_model_load: error loading model: tensor 'blk.0' data is not within the file bounds"), "load_failed");
  assert.equal(C.engineFault("dyld: Library not loaded: @rpath/libggml-metal.dylib"), "missing_lib");
  assert.equal(C.engineFault("Segmentation fault: 11"), "crash");
  assert.equal(C.engineFault("something nobody has seen before"), "unknown");
  assert.equal(C.engineFault(null), null);
  assert.equal(C.engineFault("   "), null);
});

test("ATO-773: local_backend_supervised carries kind, counts and a fault code only", () => {
  assert.deepEqual(C.supervisedProps({ kind: "restarting", reason: "the agent could not reach the local model server", quickDeaths: 1 }, 1),
    { kind: "restarting", quick_deaths: 1, after_ms: null, fault: null });
  assert.deepEqual(C.supervisedProps({ kind: "restarted", afterMs: 4200 }, 1),
    { kind: "restarted", quick_deaths: 1, after_ms: 4200, fault: null });
  const failed = C.supervisedProps({ kind: "restart_failed", error: "spawn /Users/someone/llama-server ENOENT", fault: "out of memory" }, 2);
  assert.deepEqual(failed, { kind: "restart_failed", quick_deaths: 2, after_ms: null, fault: "oom" });
  assert.ok(!JSON.stringify(failed).includes("/Users"));
  assert.deepEqual(C.supervisedProps({ kind: "gave_up", deaths: 3, fault: null }, 3),
    { kind: "gave_up", quick_deaths: 3, after_ms: null, fault: null });
  // `clear` closes an incident and is not news; ATO-244's CPU word shares the channel and is not this event.
  assert.equal(C.supervisedProps({ kind: "clear" }, 0), null);
  assert.equal(C.supervisedProps({ kind: "cpu_only", cpuOnly: true, seq: 1, modelId: null }, 0), null);
  const v = V.validateEvent("local_backend_supervised", { kind: "restarted", quick_deaths: 1, after_ms: 4200, engine: "atomic-core", fault: null, reason: "text" }, "main");
  assert.deepEqual(v.props, { kind: "restarted", quick_deaths: 1, after_ms: 4200, engine: "atomic-core", fault: null });
  assert.equal(V.validateEvent("local_backend_supervised", { kind: "gave_up", fault: "the log line itself" }, "main").props.fault, undefined);
  assert.equal(V.validateEvent("local_backend_supervised", { kind: "restarting" }, "ui"), null);
});

test("ATO-278: why a start failed, or a server died, becomes a code, never text", () => {
  assert.equal(C.backendFailReason("the agent did not answer `atag models start` within 300s — it may be busy or starting up. Try again.", "", null), "timeout");
  assert.equal(C.backendFailReason("the model server stopped answering while it was starting — it was not started; start it again", "", "Segmentation fault: 11"), "exited_after_ready");
  assert.equal(C.backendFailReason("`atag models start` failed without saying why (exit 1)", "", "ggml_metal_buffer: failed to allocate buffer: out of memory"), "oom");
  assert.equal(C.backendFailReason("llama_model_load: error loading model: /Users/someone/models/x/x.gguf", null, null), "load_failed");
  assert.equal(C.backendFailReason("couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 19091", null, null), "port_in_use");
  assert.equal(C.backendFailReason("dyld: Library not loaded: @rpath/libggml-metal.dylib", null, null), "missing_lib");
  assert.equal(C.backendFailReason(null, null, "Segmentation fault: 11"), "crash");
  assert.equal(C.backendFailReason("something nobody has seen before", "nor this", "nor this line"), "other");
  assert.equal(C.backendFailReason(null, null, null), "other");
});

test("ATO-278: only the stderr line that names a failure is classified, and timeout is the app's own limit only", () => {
  // A loaded library note is not a missing library: the out-of-memory line after it is the cause.
  const stderr = "load_backend: loaded CUDA backend from C:\\atomic\\ggml-cuda.dll\nggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory";
  assert.equal(C.backendFailReason("`atag models start` failed without saying why (exit 1)", stderr, null), "oom");
  assert.equal(C.backendFailReason("`atag models start` failed (exit 1)", "load_backend: loaded Metal backend from libggml-metal.dylib", null), "other");
  // A backend check's "timeout" in the stderr is not the start timing out.
  assert.equal(C.backendFailReason("`atag models start` failed (exit 1)", "backend update check failed: timeout", null), "other");
  assert.equal(C.backendFailReason("the start timed out somewhere else", "", null), "other");
});

test("ATO-278: a start's reason is read only for start_failed, from the bring-up's answer and the log line", () => {
  const oomLog = () => "cudaMalloc failed: out of memory";
  assert.equal(SU.startFailReason("start_failed", { daemon: "start-failed", error: "the agent did not answer `atag models start` within 300s" }, () => null), "timeout");
  assert.equal(SU.startFailReason("start_failed", { daemon: "start-failed", error: "`atag models start` failed (exit 1)" }, oomLog), "oom");
  assert.equal(SU.startFailReason("start_failed", undefined, () => null), "other");
  for (const effect of ["started", "restarted", "stop_failed", "untouched"]) {
    assert.equal(SU.startFailReason(effect, { error: "out of memory" }, oomLog), null, effect);
  }
});

test("ATO-278: main.ts hands the bring-up's answer to local_backend_started at both call sites", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /A\.localBackendStarted\("swap", r\.daemon, r\.modelId, null, r\)/);
  assert.match(main, /A\.localBackendStarted\("launch", up\.daemon, target\.modelId, Date\.now\(\) - bringUpAt, up\)/);
});

test("ATO-278: local_backend_started carries a reason code; local_backend_crashed carries code, model, uptime and engine only", () => {
  const base = { via: "swap", result: "start_failed", model_id: "hf_custom", ms: null, engine: "atomic-core" };
  assert.equal(V.validateEvent("local_backend_started", { ...base, reason: "oom" }, "main").props.reason, "oom");
  assert.equal(V.validateEvent("local_backend_started", { ...base, result: "started", reason: null }, "main").props.reason, null);
  // Text that slipped through is never sent as text.
  assert.equal(V.validateEvent("local_backend_started", { ...base, reason: "/Users/someone/models out of memory" }, "main").props.reason, "other");
  const crashed = V.validateEvent("local_backend_crashed", {
    reason: "crash", model_id: "someone/private-model", up_ms: 12_000, engine: "llama-server",
    fault: "Segmentation fault at /Users/someone/llama-server", error: "spawn /Users/someone ENOENT",
  }, "main");
  assert.deepEqual(crashed.props, { reason: "crash", model_id: "hf_custom", up_ms: 12_000, engine: "llama-server" });
  assert.ok(!JSON.stringify(crashed.props).includes("/Users"));
  assert.equal(V.validateEvent("local_backend_crashed", { reason: "a raw log line" }, "main").props.reason, "other");
  assert.equal(V.validateEvent("local_backend_crashed", { reason: "crash" }, "ui"), null);
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
    approvals_asked: 1, tool_calls: 2, tools_used: ["os.shell.run", "mcp"], error_category: "transport", http_status: null,
    coding_mode: "plan",
  });
});

test("a turn the agent stopped early (finish reason length) is stopped_early, not completed (ATO-275)", () => {
  const out = [];
  const t = new T.ChatTurnTracker((s) => out.push(s));
  t.begin("t4");
  t.observe({ turnId: "t4", kind: "delta", text: "partial" });
  t.observe({ turnId: "t4", kind: "finish", reason: "length" });
  t.observe({ turnId: "t4", kind: "done" });
  t.begin("t5");
  t.observe({ turnId: "t5", kind: "finish", reason: "stop" });
  t.observe({ turnId: "t5", kind: "done" });
  assert.equal(out[0].outcome, "stopped_early");
  assert.equal(out[0].error_category, null);
  assert.equal(out[1].outcome, "completed");
  assert.equal(V.validateEvent("chat_turn_ui", { outcome: "stopped_early" }, "main").props.outcome, "stopped_early");
});

test("the desktop's own HTTP and network failures are transport, with the status (ATO-275)", () => {
  const out = [];
  const t = new T.ChatTurnTracker((s) => out.push(s));
  t.begin("t6");
  t.observe({ turnId: "t6", kind: "error", error: "HTTP 503", transport: true, httpStatus: 503 });
  t.begin("t7");
  t.observe({ turnId: "t7", kind: "error", error: "fetch failed", transport: true });
  t.begin("t8");
  t.observe({ turnId: "t8", kind: "error", error: "not connected" });
  assert.deepEqual(out.map((s) => [s.error_category, s.http_status]), [["transport", 503], ["transport", null], [null, null]]);
  assert.equal(V.validateEvent("chat_turn_ui", { outcome: "failed", http_status: 503 }, "main").props.http_status, 503);
});

test("a redelivered approval request is counted once (ATO-203)", () => {
  const out = [];
  const t = new T.ChatTurnTracker((s) => out.push(s));
  t.begin("t3");
  t.observe({ turnId: "t3", kind: "session_id", payload: { session_id: "s3" } });
  t.approval({ sessionId: "s3", approvalId: "a1", tool: "os.shell.run" });
  t.approval({ sessionId: "s3", approvalId: "a1", tool: "os.shell.run" });
  t.approval({ sessionId: "s3", approvalId: "a2", tool: "os.shell.run" });
  t.observe({ turnId: "t3", kind: "done" });
  assert.equal(out[0].approvals_asked, 2);
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

test("app_opened carries whether the mac app runs from Applications (ATO-370)", () => {
  assert.deepEqual(V.validateEvent("app_opened", { launch_kind: "cold", in_applications: false }, "main").props,
    { launch_kind: "cold", in_applications: false });
});
