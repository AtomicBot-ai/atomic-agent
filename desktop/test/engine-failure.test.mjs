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

test("every ordinary Core failure is retryable: the card offers Download again", () => {
  assert.equal(engineFailureIn(`Could not fetch Atomic Core checksums (503). ${HINT}`).retryable, true);
  assert.equal(engineFailureIn(`Atomic Core did not become ready. ${HINT}`).retryable, true);
  assert.equal(engineFailureIn("The Atomic Chat engine could not start.").retryable, true);
});

test("a failure Download again cannot change is not retryable and says why in a plain sentence", () => {
  // The agent's wording, with the hint (older agents) or without it (newer ones).
  const cases = [
    ["The Atomic Chat engine could not be downloaded: Atomic Core does not support ia32.", "unsupported", /does not run on this computer/],
    [`The downloaded Atomic Chat engine did not pass verification: the binary does not match its release version. ${HINT}`, "version", /Update the app/],
    ["Atomic Chat could not install its inference backend: Atomic Core found no compatible inference backend for this computer.", "no_backend", /no build that runs/],
    [`The Atomic Chat engine could not be downloaded: ENOSPC: no space left on device, write. ${HINT}`, "disk", /disk space/],
  ];
  for (const [text, reason, why] of cases) {
    const f = engineFailureIn(text);
    assert.ok(f, text);
    assert.equal(f.retryable, false, text);
    assert.equal(f.reason, reason, text);
    assert.match(f.why, why);
    assert.doesNotMatch(f.why, /try again|llama/i);
  }
});

test("a structured retryable:false is honoured", () => {
  assert.equal(engineFailureIn('The Atomic Chat engine could not start. {"stage":"start","retryable":false}').retryable, false);
});

test("a start the app ended on its time limit while Core was downloading: the download did not finish", () => {
  const stderr = "[======              ] 30%  0.21 GB / 0.70 GB  Atomic Chat engine\n";
  const timedOut = {
    ok: false, stdout: "", stderr,
    error: "the agent did not answer `atag models start` within 1200s — it may be busy or starting up. Try again. ([======              ] 30%  0.21 GB / 0.70 GB  Atomic Chat engine)",
  };
  const f = engineFailureOf(timedOut);
  assert.equal(f.stage, "download");
  assert.equal(f.reason, "incomplete");
  assert.equal(f.retryable, true);
  assert.match(f.why, /did not finish/);
  // The update's own stall limit, with the bar printed, reads the same.
  const stalled = engineFailureOf({ ok: false, stdout: "", stderr, error: "the local engine update made no progress for 300 s and was stopped — there is no local engine installed yet to start the model on; try again once the connection is back" });
  assert.equal(stalled.reason, "incomplete");
  // A timeout with no Core progress is not this (llama.cpp, a slow model load).
  assert.equal(engineFailureOf({ ok: false, stdout: "", stderr: "", error: "the agent did not answer `atag models start` within 300s — it may be busy or starting up. Try again." }), null);
  // A start killed on purpose (a stop, the quit) is still not a failure.
  assert.equal(engineFailureOf({ ok: false, stdout: "", stderr, error: "`atag models start` was stopped before it finished" }), null);
});

test("a launch start's failure is read through its stderr tail (daemonError) too", () => {
  const f = engineFailureOf({
    daemon: "start-failed",
    error: "the agent did not answer `atag models start` within 1200s — it may be busy or starting up. Try again. (note: checking the engine)",
    daemonError: "note: checking the engine\n[==========          ] 50%  0.35 GB / 0.70 GB  Atomic Chat engine\n",
  });
  assert.equal(f.reason, "incomplete");
});
