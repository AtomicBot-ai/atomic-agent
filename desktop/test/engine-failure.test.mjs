// Unit tests for main/engine-failure.ts, against the built output.
// Run: npm run build && npm run test:unit
// Atomic Chat Core is the default local engine; a Core failure the agent
// reports (its retry hint, an older hint, one of its stage sentences, or a
// line naming Atomic Core) becomes one plain sentence for the recovery card.
// Anything else is not a Core failure. The card never offers llama.cpp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { engineFailureIn, engineFailureOf, CORE_RETRY } = require("../out/main/engine-failure.js");
const HINT = `${CORE_RETRY} (TUI: press R in Models).`;

test("no hint and no Atomic Core: not a Core failure", () => {
  assert.equal(engineFailureIn(""), null);
  assert.equal(engineFailureIn("models start exited with code 1"), null);
  assert.equal(engineFailureIn("llama-server: failed to load model"), null);
});

test("a precondition or a stop on purpose earns no card", () => {
  assert.equal(engineFailureIn(`Stop local models before updating the engine. Your running models are unchanged. ${HINT}`), null);
  assert.equal(engineFailureIn("`atag models update` was stopped before it finished (Atomic Core)"), null);
});

test("download, verify, backend, blocked and start each read as their own sentence", () => {
  const download = engineFailureIn(`Could not fetch Atomic Core checksums (503). ${HINT}`);
  assert.equal(download.stage, "download");
  assert.match(download.why, /download failed/);
  assert.equal(download.detail, "Could not fetch Atomic Core checksums (503).");

  assert.equal(engineFailureIn(`Atomic Core download failed checksum verification. The previous engine is unchanged. ${HINT}`).stage, "verify");
  assert.equal(engineFailureIn(`Atomic Core found no compatible inference backend for this computer. ${HINT}`).stage, "backend");
  assert.equal(engineFailureIn(`spawn /x/atomic-chat-core EACCES ${HINT}`).stage, "blocked");
  assert.equal(engineFailureIn(`Atomic Core did not become ready. ${HINT}`).stage, "start");
});

test("a structured stage wins over the wording, but blocked wins over both", () => {
  assert.equal(engineFailureIn(`CoreUnavailableError stage: backend, Atomic Core download stalled. ${HINT}`).stage, "backend");
  assert.equal(engineFailureIn(`CoreUnavailableError stage=start operation not permitted ${HINT}`).stage, "blocked");
});

test("the detail is the agent's sentence, not a progress line or a stack frame", () => {
  const f = engineFailureIn([
    "current: none → latest: b9999",
    "[==========          ] 50%  0.05 GB / 0.10 GB  backend zip",
    "Atomic Core download failed: socket hang up",
    "    at downloadFile (file:///x/download-file.js:10:5)",
    HINT,
  ].join("\n"));
  assert.equal(f.stage, "download");
  assert.equal(f.detail, "Atomic Core download failed: socket hang up");
});

test("an IPC answer is read through its error fields; a success is not a failure", () => {
  assert.equal(engineFailureOf({ ok: true, stdout: "done" }), null);
  assert.equal(engineFailureOf({ ok: false, stdout: "", stderr: `Atomic Core did not start. ${HINT}`, error: "models start exited with code 1" }).stage, "start");
  assert.equal(engineFailureOf({ ok: true, daemon: "start-failed", daemonLine: `could not start: Atomic Core did not start. ${HINT}` }).stage, "start");
  assert.equal(engineFailureOf({ ok: false, error: "the agent did not answer in time" }), null);
  assert.equal(engineFailureOf(null), null);
});

test("the agent's current wording (retry only) and the older ones all read", () => {
  const now = engineFailureIn("The Atomic Chat engine could not be downloaded: fetch failed. Retry with: atomic-agent models update (TUI: press R in Models).");
  assert.equal(now.stage, "download");
  assert.equal(now.detail, "The Atomic Chat engine could not be downloaded: fetch failed.");
  const withWayBack = engineFailureIn("Atomic Core could not be downloaded. Retry with: atomic-agent models update (TUI: press R in Models). Or use llama.cpp: atomic-agent models engine llama-server (TUI: /model engine llama-server).");
  assert.equal(withWayBack.stage, "download");
  assert.equal(withWayBack.detail, "Atomic Core could not be downloaded.");
  const old = engineFailureIn("Atomic Core did not become ready. Switch back with: atomic-agent models engine llama-server (TUI: /model engine llama-server).");
  assert.equal(old.stage, "start");
  assert.equal(old.detail, "Atomic Core did not become ready.");
});

test("the agent's CoreUnavailableError sentences map to their stages", () => {
  const tail = " Retry with: atomic-agent models update (TUI: press R in Models).";
  assert.equal(engineFailureIn("The downloaded Atomic Chat engine did not pass verification." + tail).stage, "verify");
  assert.equal(engineFailureIn("Atomic Chat could not install its inference backend." + tail).stage, "backend");
  assert.equal(engineFailureIn("The Atomic Chat engine could not start." + tail).stage, "start");
  // A start whose detail mentions the network is still a start.
  assert.equal(engineFailureIn("The Atomic Chat engine could not start: fetch failed." + tail).stage, "start");
});

test("a stage sentence alone, without any hint, is still a Core failure", () => {
  assert.equal(engineFailureIn("The Atomic Chat engine could not be downloaded: fetch failed.").stage, "download");
  assert.equal(engineFailureIn("The downloaded Atomic Chat engine did not pass verification.").stage, "verify");
  assert.equal(engineFailureIn("Atomic Chat could not install its inference backend.").stage, "backend");
  assert.equal(engineFailureIn("The Atomic Chat engine could not start.").stage, "start");
});

test("the retry hint alone marks a Core failure, and no sentence names llama.cpp", () => {
  const f = engineFailureIn("models start exited with code 1\nSomething went wrong. Retry with: atomic-agent models update (TUI: press R in Models).");
  assert.equal(f.stage, "start");
  assert.equal(f.detail, "Something went wrong.");
  for (const stage of ["download", "verify", "backend", "blocked", "start"]) {
    const sample = { download: "fetch failed", verify: "checksum mismatch", backend: "no compatible inference backend", blocked: "EACCES", start: "did not become ready" }[stage];
    assert.doesNotMatch(engineFailureIn(`Atomic Core: ${sample}. ${HINT}`).why, /llama/i);
  }
});
