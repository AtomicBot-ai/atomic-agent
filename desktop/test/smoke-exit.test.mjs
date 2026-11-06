// Unit tests for main/smoke-exit.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-896: a smoke whose final screenshot fails, or whose suite throws, still
// prints its verdict and exits. ATO-825: a smoke on a throwaway directory stops
// the model server it used, on its own exit and when its job is stopped, and
// refuses to start on model ports a stopped run left taken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const {
  smokeMayStopModels, smokeOwnsItsState, smokeScreenshot, runSmokeGuarded,
  onSmokeStopSignal, signalExitCode, SMOKE_STOP_SIGNALS, portTaken, modelPortsOf, busyPorts,
} = require("../out/main/smoke-exit.js");

const TUI = "/Users/op/.atomic-agent";
const RUN = "/Users/op/atomic-agent-desktop-qa/runs/smoke-full-1/state";

test("a throwaway run directory may stop the model server whose data lives inside it", () => {
  assert.equal(smokeMayStopModels({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: `${RUN}/models` }), true);
  assert.equal(smokeMayStopModels({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: RUN }), true);
});

test("the operator's own directory, a default directory or data outside the run is never stopped", () => {
  assert.equal(smokeMayStopModels({ stateDir: TUI, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: `${TUI}/models` }), false);
  assert.equal(smokeMayStopModels({ stateDir: `${TUI}/`, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: `${TUI}/models` }), false);
  assert.equal(smokeMayStopModels({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: false, dataDir: `${RUN}/models` }), false);
  assert.equal(smokeMayStopModels({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: `${TUI}/models` }), false);
  assert.equal(smokeMayStopModels({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: `${RUN}-other/models` }), false);
  assert.equal(smokeMayStopModels({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: true, dataDir: `${RUN}/../models` }), false);
});

test("smokeOwnsItsState: env-named and not the terminal's directory", () => {
  assert.equal(smokeOwnsItsState({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: true }), true);
  assert.equal(smokeOwnsItsState({ stateDir: RUN, tuiStateDir: TUI, stateDirFromEnv: false }), false);
  assert.equal(smokeOwnsItsState({ stateDir: TUI, tuiStateDir: TUI, stateDirFromEnv: true }), false);
});

test("a screenshot that cannot be taken costs the picture, not the run (ATO-896)", async () => {
  const line = await smokeScreenshot(
    async () => { throw new Error("Current display surface not available for capture"); },
    () => { throw new Error("must not write"); },
    3,
  );
  assert.match(line, /^SMOKE screenshot unavailable: Current display surface not available for capture failures=3\n$/);
});

test("a screenshot that works is written and named", async () => {
  let wrote = null;
  const line = await smokeScreenshot(
    async () => ({ toPNG: () => Buffer.from("png") }),
    (png) => { wrote = png.toString(); return "/tmp/x.png"; },
    0,
  );
  assert.equal(wrote, "png");
  assert.equal(line, "SMOKE screenshot=/tmp/x.png failures=0\n");
});

test("a suite that throws ends the run with exit 1 and says why (ATO-896)", async () => {
  const printed = [];
  const exits = [];
  await runSmokeGuarded(async () => { throw new Error("boom"); }, (l) => printed.push(l), (c) => exits.push(c));
  assert.deepEqual(exits, [1]);
  assert.match(printed.join(""), /^FAIL smoke: .*boom/);
});

test("a suite that finishes on its own is left to exit by itself", async () => {
  const exits = [];
  await runSmokeGuarded(async () => {}, () => {}, (c) => exits.push(c));
  assert.deepEqual(exits, []);
});

test("every stop signal runs the cleanup, once (ATO-825)", () => {
  const proc = new EventEmitter();
  const seen = [];
  onSmokeStopSignal(proc, (sig) => seen.push(sig));
  assert.deepEqual([...SMOKE_STOP_SIGNALS].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  proc.emit("SIGHUP");
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  assert.deepEqual(seen, ["SIGHUP"]);
});

test("a repeat of the same stop signal is still caught, so the cleanup is not cut short", () => {
  const proc = new EventEmitter();
  const seen = [];
  onSmokeStopSignal(proc, (sig) => seen.push(sig));
  proc.emit("SIGINT");
  // A real process with no listener left for SIGINT would take the default action (exit) here.
  assert.equal(proc.listenerCount("SIGINT"), 1);
  proc.emit("SIGINT");
  assert.deepEqual(seen, ["SIGINT"]);
});

test("signal exit codes are the shell's", () => {
  assert.equal(signalExitCode("SIGHUP"), 129);
  assert.equal(signalExitCode("SIGINT"), 130);
  assert.equal(signalExitCode("SIGTERM"), 143);
  assert.equal(signalExitCode("SIGWHAT"), 1);
});

test("modelPortsOf reads the managed and embedding ports, skipping junk and duplicates", () => {
  assert.deepEqual(modelPortsOf({ localModels: { managed: { port: 19491 }, embeddings: { port: 19492 } } }), [19491, 19492]);
  assert.deepEqual(modelPortsOf({ localModels: { managed: { port: 19491 }, embeddings: { port: 19491 } } }), [19491]);
  assert.deepEqual(modelPortsOf({ localModels: { managed: { port: "x" }, embeddings: { port: 0 } } }), []);
  assert.deepEqual(modelPortsOf(null), []);
  assert.deepEqual(modelPortsOf({}), []);
});

test("busyPorts names only the taken ones", async () => {
  const taken = await busyPorts([1, 2, 3], async (p) => p === 2);
  assert.deepEqual(taken, [2]);
});

test("portTaken sees a listener and a free port (ATO-825)", async () => {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    assert.equal(await portTaken(port), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await portTaken(port), false);
});
