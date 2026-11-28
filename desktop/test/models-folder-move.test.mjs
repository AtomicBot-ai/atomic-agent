// ATO-2503: one models folder move (main/models-folder-move.ts) with a fake
// agent child: the cooperative Cancel (a "stop" line, no kill on Windows),
// the quiet-time watchdog, the kill fallback, the move in the daemon's turn,
// and a Cancel that comes before the move began. Against the built output:
// npm run build && npm run test:unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const V = require("../out/main/models-folder-move.js");
const M = require("../out/main/models-folder.js");

/** A stand-in for the agent: records stdin and signals; `rollsBack` answers a stop like the real agent. */
function fakeAgent({ rollsBack = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signals = [];
  child.stdinText = "";
  child.args = null;
  const exit = (code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    setImmediate(() => child.emit("close", code));
  };
  child.exit = exit;
  child.stdin.on("data", (b) => {
    child.stdinText += b.toString();
    if (rollsBack && /stop\n/.test(child.stdinText)) {
      child.stderr.write("models dir: the move was stopped; every model is back in the old folder\n");
      setImmediate(() => exit(1));
    }
  });
  child.kill = (sig) => {
    child.signals.push(sig);
    if (sig === "SIGKILL") exit(null);
    return true;
  };
  return child;
}

const spawnOf = (child) => (binary, args) => { child.args = args; return child; };

test("the move asks the agent to stop on stdin", async () => {
  const child = fakeAgent();
  const p = V.runMove("atag", ["models", "dir", "/x"], { spawnChild: spawnOf(child), platform: "darwin" });
  child.stdout.write("models folder: /x\n");
  child.exit(0);
  const res = await p;
  assert.deepEqual(child.args, ["models", "dir", "/x", V.STOP_ON_STDIN_FLAG]);
  assert.equal(res.ok, true);
  assert.equal(res.dir, "/x");
});

test("Windows: Cancel sends a stop line and no signal, so the agent rolls back", async () => {
  const child = fakeAgent();
  let stop = null;
  const p = V.runMove("atag", ["models", "dir", "/x"], { spawnChild: spawnOf(child), platform: "win32", onStop: (s) => { stop = s; } });
  stop();
  stop();
  const res = await p;
  assert.equal(child.stdinText, "stop\n");
  assert.deepEqual(child.signals, []);
  assert.equal(res.ok, false);
  assert.match(res.error, /back in the old folder/);
});

test("macOS: Cancel sends the stop line and one SIGTERM", async () => {
  const child = fakeAgent();
  let stop = null;
  const p = V.runMove("atag", ["models", "dir", "/x"], { spawnChild: spawnOf(child), platform: "darwin", onStop: (s) => { stop = s; } });
  stop();
  stop();
  await p;
  assert.equal(child.stdinText, "stop\n");
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("an agent that does not end after the stop is killed, and the answer says what may be left", async () => {
  const child = fakeAgent({ rollsBack: false });
  let stop = null;
  const p = V.runMove("atag", ["models", "dir", "/x"], {
    spawnChild: spawnOf(child), platform: "win32", graceMs: 20, onStop: (s) => { stop = s; },
  });
  stop();
  const res = await p;
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(res.error, V.MOVE_FORCED_WORDS);
});

test("a quiet move is stopped after quietMs, then killed after graceMs", async () => {
  const child = fakeAgent({ rollsBack: false });
  const p = V.runMove("atag", ["models", "dir", "/x"], { spawnChild: spawnOf(child), platform: "darwin", quietMs: 30, graceMs: 20 });
  const res = await p;
  assert.equal(child.stdinText, "stop\n");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(res.error, M.MOVE_HUNG_WORDS);
});

test("output keeps the watchdog quiet", async () => {
  const child = fakeAgent();
  const p = V.runMove("atag", ["models", "dir", "/x"], { spawnChild: spawnOf(child), platform: "darwin", quietMs: 40 });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 20));
    child.stdout.write(`copied ${i + 1} of 10 bytes (qwen)\n`);
  }
  child.stdout.write("models folder: /x\n");
  child.exit(0);
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(child.stdinText, "");
});

test("the move runs inside the daemon's turn and the config lock", async () => {
  const order = [];
  const mover = V.createModelsFolderMover({
    turn: async (run) => { order.push("turn"); const r = await run(); order.push("turn end"); return r; },
    configLock: async (run) => { order.push("lock"); return run(); },
    run: async () => { order.push("run"); return { ok: true, dir: "/x" }; },
  });
  const res = await mover.move("atag", ["models", "dir", "/x"]);
  assert.deepEqual(order, ["turn", "lock", "run", "turn end"]);
  assert.equal(res.ok, true);
  assert.equal(mover.moving, false);
});

test("a Cancel while the move waits for its turn stops it before anything is spawned", async () => {
  let enter = null;
  let ran = 0;
  const mover = V.createModelsFolderMover({
    turn: (run) => new Promise((r) => { enter = () => r(run()); }),
    configLock: (run) => run(),
    run: async () => { ran += 1; return { ok: true, dir: "/x" }; },
  });
  const p = mover.move("atag", ["models", "dir", "/x"]);
  assert.equal(mover.moving, true);
  assert.deepEqual(mover.cancel(), { ok: true });
  enter();
  const res = await p;
  assert.equal(ran, 0);
  assert.equal(res.ok, false);
  assert.equal(res.error, V.MOVE_CANCELLED_BEFORE_START_WORDS);
  assert.deepEqual(mover.cancel(), { ok: false, error: "No move is under way." });
});

test("a Cancel during the move reaches the running agent's stop", async () => {
  let stops = 0;
  let release = null;
  const mover = V.createModelsFolderMover({
    turn: (run) => run(),
    configLock: (run) => run(),
    run: (_b, _a, opts) => new Promise((r) => { opts.onStop(() => { stops += 1; }); release = () => r({ ok: false, error: "stopped" }); }),
  });
  const p = mover.move("atag", ["models", "dir", "/x"]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(mover.cancel(), { ok: true });
  assert.equal(stops, 1);
  release();
  await p;
});
