#!/usr/bin/env node
// A stand-in for `atomic-agent-sidecar` used by the SDK tests. It speaks
// the same NDJSON frames as src/sidecar/main.ts but scripts the turns from
// the prompt text, so the tests need no model, no state dir and no build.
//
//   "hello"          -> two deltas, a progress note, a final reply
//   "needs approval" -> an approval_request; the tool result says what came back
//   "slow"           -> waits for `cancel`, then ends the turn as cancelled
//   "fail"           -> the send_message request fails
//   "crash"          -> writes to stderr and exits with code 3
import { randomUUID } from "node:crypto";

let buffer = "";
let sessionCounter = 0;
let sessionId = null;
const approvals = new Map();
let cancelTurn = null;

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const event = (type, payload) => write({ kind: "event", id: randomUUID(), type, payload });
const respond = (correlationId, payload, ok = true, error) =>
  write({ kind: "response", id: randomUUID(), correlationId, ok, payload, ...(error ? { error } : {}) });

async function sendMessage(req) {
  const { text } = req.payload;
  if (req.payload.sessionId !== sessionId) {
    respond(req.id, {}, false, { message: `no active session with id ${req.payload.sessionId}`, code: "handler_failed" });
    return;
  }
  if (text === "fail") {
    respond(req.id, {}, false, { message: "model exploded", code: "handler_failed" });
    return;
  }
  if (text === "crash") {
    process.stderr.write("fatal: fake sidecar crashed on purpose\n");
    process.exit(3);
  }
  event("turn_started", { sessionId, turnIndex: 0 });
  event("user_message", { sessionId, text });
  // An event for another session must never reach this thread.
  event("assistant_delta", { sessionId: "someone-else", text: "LEAK" });
  event("log", { level: "info", message: "turn running" });

  let reason = "reply";
  if (text === "needs approval") {
    const approvalId = randomUUID();
    const answer = new Promise((resolve) => approvals.set(approvalId, resolve));
    event("approval_request", { approvalId, sessionId, tool: "os.shell", category: "shell", reason: "run ls", canSession: true, canShape: true, canAlways: false });
    const response = await answer;
    event("tool_call_result", {
      sessionId, stepIndex: -1, tool: "os.shell",
      status: response.approved ? "ok" : "error",
      summary: JSON.stringify(response),
    });
    event("assistant_reply", { sessionId, text: response.approved ? "ran it" : "denied" });
  } else if (text === "slow") {
    await new Promise((resolve) => { cancelTurn = resolve; });
    cancelTurn = null;
    reason = "cancelled";
  } else {
    event("assistant_delta", { sessionId, text: "Hel" });
    event("assistant_delta", { sessionId, text: "lo" });
    event("assistant_reply", { sessionId, text: "working on it", progressNote: true });
    event("assistant_reply", { sessionId, text: `Hello from ${req.payload.maxSteps ?? "default"} steps` });
  }
  event("turn_finished", { sessionId, turnIndex: 0, reason, stepCount: 1, durationMs: 1 });
  respond(req.id, { reason, turnCount: 1, stepCount: 1 });
}

function handle(req) {
  switch (req.type) {
    case "ping":
      respond(req.id, { ok: true, llamaUrl: "http://127.0.0.1:0", stateDir: process.env.FAKE_STATE_DIR ?? "/tmp/fake", version: "0.0.0-fake" });
      break;
    case "start_session":
      sessionCounter += 1;
      sessionId = `s-${sessionCounter}`;
      event("session_started", { sessionId, workingDir: req.payload.workingDir });
      respond(req.id, { sessionId });
      break;
    case "send_message":
      void sendMessage(req);
      break;
    case "approval_response": {
      const resolve = approvals.get(req.payload.approvalId);
      approvals.delete(req.payload.approvalId);
      resolve?.(req.payload);
      respond(req.id, { resolved: Boolean(resolve) });
      break;
    }
    case "steer_message":
      respond(req.id, { steered: false });
      break;
    case "cancel":
      cancelTurn?.();
      respond(req.id, { cancelled: true });
      break;
    case "get_session":
      respond(req.id, { id: req.payload.sessionId });
      break;
    case "shutdown":
      respond(req.id, { ok: true });
      break;
    default:
      respond(req.id, {}, false, { message: `no handler for request type: ${req.type}`, code: "unknown_request" });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf("\n");
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(JSON.parse(line));
    i = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
// Not a frame: the client must skip it.
process.stdout.write("fake sidecar booted\n");
event("log", { level: "info", message: "atomic-agent sidecar booted" });
