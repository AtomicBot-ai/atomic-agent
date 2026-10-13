// Unit tests for the quit's model-server stop under Atomic Chat Core
// (main/backend-switch.ts stopDaemonForQuit), against the built output.
// Run: npm run build && npm run test:unit
// Core owns its model sessions; the quit never kills Core's processes. A
// `models stop` that timed out or failed while Core still records a session
// is asked once more, and that is all.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const home = mkdtempSync(join(tmpdir(), "quit-core-stop-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { withCliStandIn } = require("../out/main/agent-cli.js");
const { stopDaemonForQuit, coreSessionsRecorded } = require("../out/main/backend-switch.js");

function dataDir({ core }) {
  const dir = mkdtempSync(join(home, "models-"));
  if (core) {
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "chat.json"), "{}\n");
  }
  return dir;
}
function stopsAnswering(answers) {
  const calls = [];
  const standIn = async (args) => {
    const verb = args.slice(0, 2).join(" ");
    calls.push(verb);
    if (verb !== "models stop") return { ok: true, stdout: "", stderr: "" };
    const next = answers.shift() ?? "ok";
    if (next === "hang") return new Promise(() => {});
    return next === "ok" ? { ok: true, stdout: "stopped\n", stderr: "" } : { ok: false, stdout: "", stderr: "", error: "models stop exited with code 1" };
  };
  return { calls, standIn };
}
const stops = (calls) => calls.filter((v) => v === "models stop").length;

test("Core's sessions are read from its records", () => {
  assert.equal(coreSessionsRecorded(dataDir({ core: true })), true);
  assert.equal(coreSessionsRecorded(dataDir({ core: false })), false);
});

test("a stop that worked is not repeated", async () => {
  const { calls, standIn } = stopsAnswering(["ok"]);
  const killed = await withCliStandIn(standIn, () => stopDaemonForQuit(dataDir({ core: true }), { stopMs: 200, retryMs: 200 }));
  assert.deepEqual(killed, []);
  assert.equal(stops(calls), 1);
});

test("a stop that timed out with Core sessions recorded is asked once more", async () => {
  const { calls, standIn } = stopsAnswering(["hang", "ok"]);
  await withCliStandIn(standIn, () => stopDaemonForQuit(dataDir({ core: true }), { stopMs: 100, retryMs: 200 }));
  assert.equal(stops(calls), 2);
});

test("a stop that failed with Core sessions recorded is asked once more, and only once", async () => {
  const { calls, standIn } = stopsAnswering(["fail", "fail"]);
  await withCliStandIn(standIn, () => stopDaemonForQuit(dataDir({ core: true }), { stopMs: 200, retryMs: 200 }));
  assert.equal(stops(calls), 2);
});

test("no Core sessions recorded (llama.cpp): no second stop, the pid-file kill covers it", async () => {
  const { calls, standIn } = stopsAnswering(["fail"]);
  await withCliStandIn(standIn, () => stopDaemonForQuit(dataDir({ core: false }), { stopMs: 200, retryMs: 200 }));
  assert.equal(stops(calls), 1);
});
