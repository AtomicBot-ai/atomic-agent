// ATO-852: an agent with #721 prints `health: key rejected` in `models status`
// when a server answers on the model's port but refuses the running model's
// key, so every request fails. The desktop read it as "health unreachable" /
// "Not answering", and a start found the daemon "already running" and did
// nothing. Now:
//   - main: modelsStatus says keyRejected, and localDaemonRunning stops such a
//     server for a start that asked (the agent's own advice: stop, then start);
//     a stop decision (reapWedged: false) still counts it as running;
//   - Settings › Models: "Key rejected" with a Restart model button.
// An older agent never prints the line, and reads exactly as before.
// main against the built output (npm run build first); the renderer as text in a vm.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const home = mkdtempSync(join(tmpdir(), "key-rejected-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { withCliStandIn, localDaemonRunning, modelsStatus, healthKeyRejected } = require("../out/main/agent-cli.js");

const status = (health) => "mode:           managed\n"
  + "daemon:         running (pid 4242)  http://127.0.0.1:19091\n"
  + `health:         ${health}\n`;

function agent(health) {
  const calls = [];
  const standIn = async (args) => {
    const verb = args.slice(0, 2).join(" ");
    calls.push(verb);
    if (verb === "models status") return { ok: true, stdout: status(health), stderr: "" };
    if (verb === "models stop") return { ok: true, stdout: "stopped\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "", error: "not this: " + verb };
  };
  return { calls, standIn };
}

test("only the agent's `key rejected` reads as a rejected key", () => {
  assert.equal(healthKeyRejected("key rejected"), true);
  assert.equal(healthKeyRejected("Key rejected "), true);
  for (const h of ["ok", "down", "loading", "", null, undefined, "unreachable"]) assert.equal(healthKeyRejected(h), false, String(h));
});

test("models status carries keyRejected for the Models pane", async () => {
  const { standIn } = agent("key rejected");
  const res = await withCliStandIn(standIn, () => modelsStatus());
  assert.equal(res.ok, true);
  assert.equal(res.status.health, "key rejected");
  assert.equal(res.status.keyRejected, true);
  const old = agent("down");
  const before = await withCliStandIn(old.standIn, () => modelsStatus());
  assert.equal(before.status.keyRejected, false);
});

test("a start that asks stops a server that rejects its key, so a fresh one comes up", async () => {
  const { calls, standIn } = agent("key rejected");
  const running = await withCliStandIn(standIn, () => localDaemonRunning());
  assert.equal(running, false);
  assert.deepEqual(calls, ["models status", "models stop"]);
});

test("a stop decision still counts it as running, and stops nothing itself", async () => {
  const { calls, standIn } = agent("key rejected");
  const running = await withCliStandIn(standIn, () => localDaemonRunning({ reapWedged: false }));
  assert.equal(running, true);
  assert.deepEqual(calls, ["models status"]);
});

test("a healthy server is untouched, as before", async () => {
  const { calls, standIn } = agent("ok");
  assert.equal(await withCliStandIn(standIn, () => localDaemonRunning()), true);
  assert.deepEqual(calls, ["models status"]);
});

/* ---- Settings › Models ---- */

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  let at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) at = source.indexOf("\nasync function " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function pane(st) {
  const c = vm.createContext({ LLMP: { status: st, daemonPhase: null, statusErr: null }, llmDaemonPort: () => "19091" });
  for (const name of ["llmFormatDaemon", "llmKeyRejected"]) vm.runInContext(fn(name), c);
  return c;
}
const st = (health, extra = {}) => ({ daemonRunning: true, daemonPid: 4242, health, ...extra });

test("the Models pane says key rejected, not unreachable", () => {
  assert.equal(pane(st("key rejected")).llmFormatDaemon(), "pid 4242 key rejected");
  assert.equal(pane(st("down", { keyRejected: true })).llmFormatDaemon(), "pid 4242 key rejected");
  // An older agent: the words it always printed.
  assert.equal(pane(st("down")).llmFormatDaemon(), "pid 4242 health unreachable");
  assert.equal(pane(st("ok")).llmFormatDaemon(), "running pid 4242 on 127.0.0.1:19091");
});

test("its line reads Key rejected and offers Restart model, which stops then starts", () => {
  assert.match(source, /: \/key rejected\$\/\.test\(d\) \? 'Key rejected'/);
  assert.match(source, /keyRejected \? button\('llm:restartModel', 'refresh'/);
  assert.match(source, /if \(verb === 'restartModel'\) \{ llmRestartModel\(\); return; \}/);
  const restart = fn("llmRestartModel");
  assert.ok(restart.indexOf("BR.modelsStop()") > 0 && restart.indexOf("BR.modelsStop()") < restart.indexOf("BR.modelsStart()"));
  assert.match(restart, /llmTurnsRunning\(\)/, "it refuses while a turn runs on the server, as Stop does");
  assert.doesNotMatch(restart, /—/, "no em dash in what it says");
  const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");
  assert.match(acts, /restartModel:L/);
});
