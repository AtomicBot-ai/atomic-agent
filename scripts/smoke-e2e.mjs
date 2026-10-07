#!/usr/bin/env node
// Offline process-level smoke: real dist sidecar, SQLite and filesystem tools.
// The loopback server supplies scripted completions, not model-quality evidence.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0
  ? await mkdtemp(join(tmpdir(), "atomic-e2e-evidence-"))
  : resolve(process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const sandbox = await mkdtemp(join(tmpdir(), "atomic-e2e-state-"));
const state = join(sandbox, "state");
const cwd = join(sandbox, "workspace");
await mkdir(state);
await mkdir(cwd);
await writeFile(join(cwd, "one.txt"), "E2E-FILE-ONE-9237\n");
await writeFile(join(cwd, "two.txt"), "E2E-FILE-TWO-7711\n");

const report = { node: process.version, backend: "scripted loopback llama HTTP/SSE", checks: [], requests: [] };
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
let queue = [];
let scenario = "startup";
let child;
let messages = [];
let stderr = "";
let stdout = "";
let parseError;
let id = 0;
let closed = false;
let exitPromise;
const sockets = new Set();
const pendingTimers = new Set();
const cliChildren = new Set();
const childEnv = (stateDir) => ({ PATH: process.env.PATH, LANG: "en_US.UTF-8", ATOMIC_AGENT_STATE_DIR: stateDir,
  ATOMIC_AGENT_GRAMMARS_DIR: join(root, "grammars"), ATOMIC_AGENT_BROWSER_ENABLED: "false",
  ATOMIC_AGENT_LLAMA_COMPLETION_RETRIES: "0", ATOMIC_AGENT_LLAMA_HEALTH_RETRIES: "0" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (parseError) throw parseError;
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timeout: ${label}; stderr: ${stderr.slice(-1500)}`);
    await sleep(15);
  }
}
const call = (tool, args) => JSON.stringify([{ tool, args }]);
const reply = (text) => call("reply", { text });
const inferences = (name) => report.requests.filter((r) => r.scenario === name && !r.auxiliary);
function script(name, completions) {
  assert.equal(queue.length, 0, "previous completion script must be consumed");
  scenario = name;
  queue = [...completions];
}

const server = http.createServer(async (req, res) => {
  const json = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.url === "/health") return json({ status: "ok" });
  if (req.url === "/props") return json({ model_path: "smoke-plain.gguf", default_generation_settings: { n_ctx: 32768 } });
  if (req.url !== "/completion" || req.method !== "POST") { res.writeHead(404); res.end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const auxiliary = String(body.prompt).startsWith("Name this work session.");
  const record = { scenario, auxiliary, body, disconnected: false };
  report.requests.push(record);
  res.on("close", () => { record.disconnected = !res.writableEnded; });
  const next = auxiliary ? "Smoke session" : queue.shift();
  if (next === undefined) { res.writeHead(500); res.end("unexpected completion"); return; }
  if (next.hold) return; // cancellation must close this real in-flight connection
  const content = typeof next === "string" ? next : next.content;
  const send = () => {
    if (res.destroyed) return;
    const payload = (text, stop) => ({ content: text, stop, truncated: false, tokens_cached: 0, slot_id: 0,
      model: "smoke-plain", timings: { prompt_ms: 1, predicted_ms: 1, prompt_n: 100, predicted_n: 15 } });
    if (!body.stream) return json(payload(content, true));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let offset = 0; offset < content.length; offset += 13) {
      res.write(`data: ${JSON.stringify(payload(content.slice(offset, offset + 13), false))}\n\n`);
    }
    res.write(`data: ${JSON.stringify(payload("", true))}\n\ndata: [DONE]\n\n`);
    res.end();
  };
  if (next.delay) {
    const timer = setTimeout(() => { pendingTimers.delete(timer); send(); }, next.delay);
    pendingTimers.add(timer);
  } else send();
});
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

function launch() {
  messages = [];
  closed = false;
  let buffer = "";
  // Do not inherit agent settings or cloud credentials from the operator's shell.
  child = spawn(process.execPath, [join(root, "dist/sidecar/main.js")], { cwd, env: childEnv(state), stdio: ["pipe", "pipe", "pipe"] });
  exitPromise = new Promise((r) => child.once("exit", (code, signal) => { closed = true; r({ code, signal }); }));
  child.on("error", (error) => { parseError = error; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try { messages.push(JSON.parse(line)); } catch (error) { parseError = error; }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
}
function request(type, payload = {}) {
  const requestId = `smoke-${++id}`;
  child.stdin.write(`${JSON.stringify({ kind: "request", id: requestId, type, payload })}\n`);
  return waitFor(() => messages.find((m) => m.kind === "response" && m.correlationId === requestId), type);
}
async function ok(type, payload) {
  const response = await request(type, payload);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.payload;
}
const events = (type, start = 0) => messages.slice(start).filter((m) => m.kind === "event" && m.type === type);
async function send(sessionId, text) {
  const result = await ok("send_message", { sessionId, text, maxSteps: 8 });
  assert.equal(queue.length, 0, "completion script must be consumed");
  return result;
}
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    report.checks.push({ name, status: "pass", durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "fail", error: error.stack, durationMs: Date.now() - started });
    throw error;
  }
}
async function stop() {
  await ok("shutdown");
  child.stdin.end();
  const result = await waitFor(() => closed && exitPromise, "sidecar exits after shutdown + stdin EOF", 5000);
  assert.deepEqual(await result, { code: 0, signal: null });
}
async function runCli(args, stateDir, input = "") {
  const processHandle = spawn(process.execPath, [join(root, "dist/cli/index.js"), ...args],
    { cwd, env: childEnv(stateDir), stdio: ["pipe", "pipe", "pipe"] });
  cliChildren.add(processHandle);
  const result = { args, stdout: "", stderr: "", timedOut: false };
  const timer = setTimeout(() => { result.timedOut = true; processHandle.kill("SIGKILL"); }, 20000);
  processHandle.stdout.on("data", (chunk) => { result.stdout += String(chunk); });
  processHandle.stderr.on("data", (chunk) => { result.stderr += String(chunk); });
  try {
    const exited = new Promise((r, reject) => {
      processHandle.once("error", reject);
      processHandle.once("close", (code, signal) => r({ code, signal }));
    });
    processHandle.stdin.on("error", (error) => { if (error.code !== "EPIPE") parseError = error; });
    processHandle.stdin.end(input);
    Object.assign(result, await exited);
    report.cli ??= [];
    report.cli.push(result);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    return result;
  } finally { clearTimeout(timer); cliChildren.delete(processHandle); }
}

try {
  await new Promise((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
  const { USER_CONFIG_DEFAULTS } = await import(new URL("../dist/config/config-schema.js", import.meta.url));
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.localModels.url = `http://127.0.0.1:${server.address().port}`;
  config.localModels.mode = "external";
  config.agent.approvalLevel = 1;
  config.analytics.enabled = false;
  for (const feature of Object.values(config.memory)) {
    if (feature && typeof feature === "object" && "enabled" in feature) feature.enabled = false;
  }
  config.tracing.trace.enabled = true;
  await writeFile(join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });
  launch();
  let sessionId;
  await check("boot, ping/version, malformed frame recovery and unknown request", async () => {
    const ping = await ok("ping");
    assert.equal(ping.version, manifest.version);
    assert.equal(ping.stateDir, state);
    child.stdin.write("{broken-json\n");
    await waitFor(() => events("error").some((m) => m.payload.code === "parse_error"), "parse_error event");
    assert.equal((await request("smoke_unknown")).ok, false);
    assert.equal((await ok("ping")).ok, true);
    sessionId = (await ok("start_session", { workingDir: cwd })).sessionId;
    assert.equal(events("llm_unavailable").length, 0);
  });
  await check("real file read reaches next prompt, streamed reply is committed once", async () => {
    const start = messages.length;
    script("read", [call("os.fs.read", { path: "one.txt" }), reply("read-ok")]);
    assert.equal((await send(sessionId, "Read one.txt")).reason, "reply");
    const reads = events("tool_call_result", start).filter((m) => m.payload.tool === "os.fs.read");
    assert.equal(reads.length, 1);
    assert.equal(reads[0].payload.status, "ok");
    assert.match(inferences("read")[1].body.prompt, /E2E-FILE-ONE-9237/);
    assert.deepEqual(events("assistant_reply", start).map((m) => m.payload.text), ["read-ok"]);
    assert.equal(events("assistant_delta", start).map((m) => m.payload.text).join(""), "read-ok");
    assert.equal((await ok("get_session", { sessionId })).turnCount, 1);
  });
  await check("batched file reads retain order and both results enter prompt", async () => {
    const start = messages.length;
    const previousTurns = (await ok("get_session", { sessionId })).turns.length;
    script("batch", [JSON.stringify([{ tool: "os.fs.read", args: { path: "one.txt" } },
      { tool: "os.fs.read", args: { path: "two.txt" } }]), reply("batch-ok")]);
    assert.equal((await send(sessionId, "Read both files")).reason, "reply");
    const reads = events("tool_call_result", start).filter((m) => m.payload.tool === "os.fs.read");
    // Results may arrive in completion order; batchIndex and persisted transcript preserve input order.
    assert.deepEqual(reads.map((m) => [m.payload.status, m.payload.batchIndex, m.payload.batchSize])
      .sort((a, b) => a[1] - b[1]), [["ok", 0, 2], ["ok", 1, 2]]);
    const turns = (await ok("get_session", { sessionId })).turns.slice(previousTurns);
    assert.deepEqual(turns.filter((t) => t.kind === "assistant_tool_call").map((t) => t.args.path), ["one.txt", "two.txt"]);
    const prompt = inferences("batch")[1].body.prompt;
    assert.match(prompt, /E2E-FILE-ONE-9237/);
    assert.match(prompt, /E2E-FILE-TWO-7711/);
  });
  for (const approved of [false, true]) {
    await check(`approval ${approved ? "accept executes" : "deny prevents"} filesystem write`, async () => {
      const start = messages.length;
      const path = approved ? "accepted.txt" : "denied.txt";
      script(`write-${approved}`, [call("os.fs.write", { path, content: "E2E-WRITE-OK\n", mode: "replace" }), reply("write-result")]);
      const pending = send(sessionId, "Write a fixture file");
      const approval = await waitFor(() => events("approval_request", start)[0], "approval request");
      assert.equal(approval.payload.tool, "os.fs.write");
      assert.equal((await ok("approval_response", { approvalId: approval.payload.approvalId, approved })).resolved, true);
      assert.equal((await pending).reason, "reply");
      if (approved) assert.equal(await readFile(join(cwd, path), "utf8"), "E2E-WRITE-OK\n");
      else await assert.rejects(readFile(join(cwd, path)), { code: "ENOENT" });
    });
  }
  await check("malformed completion takes repair path and ends with one reply", async () => {
    const start = messages.length;
    script("repair", ["not valid JSON", reply("repair-ok")]);
    assert.equal((await send(sessionId, "Test repair")).reason, "reply");
    const repairRequests = inferences("repair");
    assert.equal(repairRequests.length, 2);
    assert.match(repairRequests[1].body.prompt, /### tool-call-repair/);
    assert.equal(repairRequests[1].body.stream, false);
    assert.deepEqual(events("assistant_reply", start).map((m) => m.payload.text), ["repair-ok"]);
  });
  await check("two concurrent host messages execute FIFO on one session", async () => {
    const start = messages.length;
    script("fifo", [{ content: reply("fifo-one"), delay: 200 }, reply("fifo-two")]);
    const first = ok("send_message", { sessionId, text: "FIFO first", maxSteps: 8 });
    const second = ok("send_message", { sessionId, text: "FIFO second", maxSteps: 8 });
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((r) => r.reason), ["reply", "reply"]);
    assert.equal(results[1].turnCount, results[0].turnCount + 1);
    assert.deepEqual(events("user_message", start).map((m) => m.payload.text), ["FIFO first", "FIFO second"]);
    assert.deepEqual(events("assistant_reply", start).map((m) => m.payload.text), ["fifo-one", "fifo-two"]);
  });
  await check("mid-turn steering is applied at the next step", async () => {
    const start = messages.length;
    script("steering", [{ content: call("os.fs.read", { path: "one.txt" }), delay: 300 }, reply("steered-ok")]);
    const pending = send(sessionId, "Read fixture before answering");
    await waitFor(() => inferences("steering")[0], "steering completion started");
    assert.equal((await ok("steer_message", { sessionId, text: "E2E-STEER-9237" })).steered, true);
    assert.equal((await pending).reason, "reply");
    assert.equal(events("steer_applied", start).length, 1);
    assert.match(inferences("steering")[1].body.prompt, /E2E-STEER-9237/);
  });
  await check("cancel aborts in-flight HTTP inference and new session still works", async () => {
    const start = messages.length;
    script("cancel", [{ hold: true }]);
    const pending = send(sessionId, "Wait for cancellation");
    const inference = await waitFor(() => inferences("cancel")[0], "held inference started");
    assert.equal((await ok("cancel", { sessionId })).cancelled, true);
    assert.equal((await pending).reason, "cancelled");
    await waitFor(() => inference.disconnected, "cancel closes inference socket", 5000);
    assert.equal(events("assistant_reply", start).length, 0);
    sessionId = (await ok("start_session", { workingDir: cwd })).sessionId;
    script("after-cancel", [reply("after-cancel-ok")]);
    assert.equal((await send(sessionId, "Fresh session")).reason, "reply");
  });
  let finishedId;
  await check("finish ends session and shutdown releases process", async () => {
    const start = messages.length;
    script("finish", [call("finish", { summary: "E2E-FINISHED" })]);
    assert.equal((await send(sessionId, "Finish this session")).reason, "finish");
    assert.equal(events("session_completed", start)[0].payload.reason, "finish");
    const session = await ok("get_session", { sessionId });
    assert.equal(session.status, "completed");
    finishedId = sessionId;
    await stop();
  });
  await check("SQLite transcript survives a complete sidecar process restart", async () => {
    launch();
    await ok("start_session", { workingDir: cwd });
    const persisted = await ok("get_session", { sessionId: finishedId });
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.turnCount, 2);
    assert(persisted.turns.some((t) => JSON.stringify(t).includes("after-cancel-ok")));
    assert(persisted.turns.some((t) => JSON.stringify(t).includes("E2E-FINISHED")));
    await stop();
  });
  const cliState = join(sandbox, "cli-state");
  await mkdir(cliState);
  await writeFile(join(cliState, "config.json"), JSON.stringify(config), { mode: 0o600 });
  await check("built CLI help and version start without inference", async () => {
    const count = report.requests.length;
    assert.match((await runCli(["--help"], cliState)).stdout, /atomic-agent|atag/);
    assert((await runCli(["--version"], cliState)).stdout.includes(manifest.version));
    assert.equal(report.requests.length, count);
  });
  await check("built CLI run dispatches real read, prints reply and exits on EOF", async () => {
    script("cli-read", [call("os.fs.read", { path: "one.txt" }), reply("E2E-CLI-READ-OK")]);
    const result = await runCli(["run", "--cwd", cwd, "--no-approval", "--max-steps", "8"], cliState, "Read one.txt\n");
    assert.equal(queue.length, 0);
    assert.match(result.stdout, /E2E-CLI-READ-OK/);
    assert.match(inferences("cli-read")[1].body.prompt, /E2E-FILE-ONE-9237/);
  });
  for (const inference of report.requests.filter((r) => !r.auxiliary)) {
    assert.equal(typeof inference.body.stream, "boolean");
    assert.equal(typeof inference.body.grammar, "string");
    assert.match(inference.body.grammar, /root\s*::=/);
  }
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const processHandle of cliChildren) processHandle.kill("SIGKILL");
  if (child && !closed) {
    child.kill("SIGTERM");
    await Promise.race([exitPromise, sleep(2000)]);
    if (!closed) { child.kill("SIGKILL"); await exitPromise; }
  }
  for (const timer of pendingTimers) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => server.close(r));
  await writeFile(join(output, "sidecar.ndjson"), stdout);
  await writeFile(join(output, "sidecar.stderr.log"), stderr);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await rm(sandbox, { recursive: true, force: true });
  console.log(`Evidence: ${output}`);
}
