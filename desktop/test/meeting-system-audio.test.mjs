// ATO-2514: the other side of a call on macOS (main/meeting-system-audio.ts): the
// helper's PCM cut into the microphone's 100 ms frames, its event lines, and the
// start / stop of the helper, with a fake process.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../out/main/meeting-system-audio.js");

test("each OS has its way to the call's sound", () => {
  assert.equal(A.systemAudioMode("darwin"), "helper");
  assert.equal(A.systemAudioMode("win32"), "loopback");
  assert.equal(A.systemAudioMode("linux"), "monitor");
  assert.equal(A.systemAudioMode("freebsd"), "none");
});

test("bytes become whole 3200-byte frames; the tail waits for the next push", () => {
  const f = new A.PcmFramer();
  assert.equal(f.push(new Uint8Array(1000)).length, 0);
  const out = f.push(new Uint8Array(6000));
  assert.deepEqual(out.map((x) => x.byteLength), [3200, 3200]);
  assert.equal(f.push(new Uint8Array(2600)).length, 1, "600 left over plus 2600 more makes the third");
});

test("the peak of a frame is its loudest sample, 0 to 1", () => {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setInt16(2, -16384, true);
  v.setInt16(6, 8192, true);
  assert.equal(A.peakOf(b), 0.5);
  assert.equal(A.peakOf(new Uint8Array(4)), 0);
});

test("the helper's stderr lines", () => {
  assert.deepEqual(A.parseHelperLine('{"type":"ready"}'), { type: "ready" });
  assert.deepEqual(A.parseHelperLine('{"type":"error","code":"screen-denied","detail":"x"}'), { type: "error", code: "screen-denied" });
  assert.equal(A.parseHelperLine("2026-11-28 log noise"), null);
  assert.equal(A.parseHelperLine('{"type":"other"}'), null);
});

function fakeSpawn() {
  const calls = [];
  const fn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { ended: false, end() { this.ended = true; } };
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, child });
    return child;
  };
  return { fn, calls };
}

test("start passes the app's bundle id, reports ready, and turns stdout into frames", () => {
  const sp = fakeSpawn();
  const frames = [];
  const states = [];
  const cap = new A.MacSystemAudio({ command: "/R/native/atomic-system-audio", excludeBundle: "io.atomicagent.desktop", onFrame: (f, p) => frames.push([f.byteLength, p]), onState: (s) => states.push(s), spawnFn: sp.fn });
  assert.equal(cap.start(), true);
  assert.equal(cap.start(), false, "once");
  const { command, args, child } = sp.calls[0];
  assert.equal(command, "/R/native/atomic-system-audio");
  assert.deepEqual(args, ["--exclude-bundle", "io.atomicagent.desktop"]);
  child.stderr.emit("data", Buffer.from('{"type":"rea'));
  child.stderr.emit("data", Buffer.from('dy"}\n'));
  assert.deepEqual(states, ["ready"]);
  child.stdout.emit("data", Buffer.alloc(3200 * 2 + 10));
  assert.deepEqual(frames, [[3200, 0], [3200, 0]]);
  cap.stop();
  assert.equal(child.stdin.ended, true, "stdin closes and the helper stops itself");
  child.stdout.emit("data", Buffer.alloc(3200));
  assert.equal(frames.length, 2, "nothing after stop");
  child.emit("exit", 0);
  assert.deepEqual(states, ["ready"], "a stop the app asked for is not reported as an exit");
});

test("no permission: screen-denied once, and an exit after that adds nothing", () => {
  const sp = fakeSpawn();
  const states = [];
  const cap = new A.MacSystemAudio({ command: "h", onFrame: () => {}, onState: (s) => states.push(s), spawnFn: sp.fn });
  cap.start();
  sp.calls[0].child.stderr.emit("data", Buffer.from('{"type":"error","code":"screen-denied"}\n'));
  sp.calls[0].child.emit("exit", 3);
  assert.deepEqual(states, ["screen-denied"]);
  assert.deepEqual(sp.calls[0].args, []);
});
