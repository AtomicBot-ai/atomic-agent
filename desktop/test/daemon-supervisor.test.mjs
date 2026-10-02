// Unit tests for main/daemon-supervisor.ts and the pure halves of
// main/daemon-watch.ts (ATO-123), against the built output.
// Run: npm run build && npm run test:unit
// The local model server is brought back when it dies under the app that
// started it — never one the app stopped on purpose, never on a route that
// does not need it, never under a start or an update, and not after three
// quick deaths in a row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DaemonSupervisor, MAX_QUICK_DEATHS } = require("../out/main/daemon-supervisor.js");
const { routeNeedsDaemon, routeWantsRestarts, isManagedServer } = require("../out/main/daemon-watch.js");

/** A supervisor on stand-ins: the test sets what the looks see and moves the clock. */
function standIn() {
  let clock = 1_000_000;
  const f = { wanted: true, look: "up", restarts: 0, answer: { ok: true }, during: null, notices: [] };
  const sv = new DaemonSupervisor({
    wanted: () => f.wanted,
    look: async () => f.look,
    restart: async () => {
      f.restarts += 1;
      if (f.during) f.during();
      return f.answer;
    },
    notify: (n) => f.notices.push(n.kind),
    say: () => {},
    describeFault: () => null,
    now: () => clock,
  });
  const disarm = sv.arm(3_600_000);
  return { sv, f, later: (ms) => { clock += ms; }, disarm };
}

test("a server the app started, seen down on two looks, is brought back once", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  later(120_000);
  f.look = "down";
  await sv.tick();
  assert.equal(f.restarts, 0);
  await sv.tick();
  disarm();
  assert.equal(f.restarts, 1);
  assert.deepEqual(f.notices, ["restarting", "restarted"]);
});

test("unarmed, it does nothing — a smoke run leaves it so", async () => {
  const { sv, f, later, disarm } = standIn();
  disarm();
  sv.noteStarted();
  later(120_000);
  f.look = "down";
  for (let i = 0; i < 3; i++) await sv.tick();
  assert.equal(await sv.checkNow("refused"), false);
  assert.equal(f.restarts, 0);
});

test("a stop on purpose, or a route that does not need it, is never fought", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  sv.noteStopped();
  later(120_000);
  f.look = "down";
  for (let i = 0; i < 3; i++) await sv.tick();
  assert.equal(await sv.checkNow("refused"), false);
  sv.noteStarted();
  f.wanted = false;
  for (let i = 0; i < 3; i++) await sv.tick();
  disarm();
  assert.equal(f.restarts, 0);
});

test("busy looks (a start, a load, an update) count nothing", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  later(120_000);
  f.look = "down";
  await sv.tick();
  f.look = "busy";
  await sv.tick();
  f.look = "down";
  await sv.tick();
  assert.equal(f.restarts, 0);
  await sv.tick();
  disarm();
  assert.equal(f.restarts, 1);
});

test("the agent's refused connection restarts it at once", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  later(120_000);
  f.look = "down";
  assert.equal(await sv.checkNow("refused"), true);
  disarm();
  assert.equal(f.restarts, 1);
});

test("after three quick deaths in a row it stops trying, and a start listens again", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  f.look = "down";
  for (let i = 0; i < MAX_QUICK_DEATHS; i++) {
    later(5_000);
    await sv.checkNow("refused");
  }
  assert.equal(sv.state().gaveUp, true);
  assert.equal(f.restarts, MAX_QUICK_DEATHS - 1);
  assert.equal(f.notices.at(-1), "gave_up");
  later(5_000);
  await sv.checkNow("refused");
  assert.equal(f.restarts, MAX_QUICK_DEATHS - 1);
  sv.noteStarted();
  assert.equal(sv.state().gaveUp, false);
  assert.equal(f.notices.at(-1), "clear");
  later(120_000);
  await sv.checkNow("refused");
  disarm();
  assert.equal(f.restarts, MAX_QUICK_DEATHS);
});

test("a stop made while it restarts wins", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  later(120_000);
  f.look = "down";
  f.during = () => sv.noteStopped();
  f.answer = { ok: false, superseded: true };
  assert.equal(await sv.checkNow("refused"), false);
  f.during = null;
  for (let i = 0; i < 3; i++) await sv.tick();
  disarm();
  assert.equal(f.restarts, 1);
  assert.deepEqual(f.notices, ["restarting", "clear"]);
  assert.equal(sv.state().owned, false);
  assert.equal(sv.state().incident, null);
});

test("an incident still open when the route moves on without a stop is closed", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  later(120_000);
  f.look = "down";
  f.answer = { ok: false, error: "no" };
  await sv.checkNow("refused");
  assert.equal(sv.state().incident.kind, "restart_failed");
  f.wanted = false;
  await sv.tick();
  disarm();
  assert.equal(sv.state().incident, null);
  assert.equal(f.notices.at(-1), "clear");
});

test("the person's own start counts quick deaths afresh", async () => {
  const { sv, f, later, disarm } = standIn();
  sv.noteStarted();
  f.look = "down";
  for (let i = 0; i < MAX_QUICK_DEATHS - 1; i++) {
    later(5_000);
    await sv.checkNow("refused");
  }
  assert.equal(sv.state().quickDeaths, MAX_QUICK_DEATHS - 1);
  sv.noteStarted();
  assert.equal(sv.state().quickDeaths, 0);
  later(5_000);
  await sv.checkNow("refused");
  disarm();
  assert.equal(sv.state().gaveUp, false);
  assert.equal(f.restarts, MAX_QUICK_DEATHS);
});

test("the route that needs the managed server: Local models, or Fusion with a local seat, with autoRestart on", () => {
  const local = { localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b" } }, llm: { activeTextProvider: "local-llama", providers: [{ id: "local-llama", kind: "llama-server" }] } };
  assert.equal(routeWantsRestarts(local), true);
  assert.equal(routeWantsRestarts({ localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b" } } }), true, "no llm block is the local route");
  assert.equal(routeWantsRestarts({ ...local, localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b", autoRestart: false } } }), false);
  // Restarting after the app's own llama.cpp update is not an auto-restart: autoRestart does not gate it.
  assert.equal(routeNeedsDaemon({ ...local, localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b", autoRestart: false } } }), true);
  assert.equal(routeWantsRestarts({ ...local, localModels: { mode: "external", managed: { modelId: "qwen-3.5-4b" } } }), false);
  assert.equal(routeWantsRestarts({ ...local, localModels: { mode: "managed", managed: { modelId: null } } }), false);
  const cloud = { ...local, llm: { activeTextProvider: "openrouter", providers: [{ id: "openrouter", kind: "openrouter" }, { id: "local-llama", kind: "llama-server" }] } };
  assert.equal(routeWantsRestarts(cloud), false);
  assert.equal(routeWantsRestarts(null), false);
});

test("a wait on the managed server: local-llama, or a llama-server entry on the managed port", () => {
  const cfg = {
    localModels: { mode: "managed", managed: { port: 19191 } },
    llm: { providers: [
      { id: "mine", kind: "llama-server", url: "http://127.0.0.1:19191" },
      { id: "elsewhere", kind: "llama-server", url: "http://127.0.0.1:8080" },
      { id: "openrouter", kind: "openrouter" },
    ] },
  };
  assert.equal(isManagedServer("local-llama", cfg), true);
  assert.equal(isManagedServer("mine", cfg), true);
  assert.equal(isManagedServer("elsewhere", cfg), false);
  assert.equal(isManagedServer("openrouter", cfg), false);
});
