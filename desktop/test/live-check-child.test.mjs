// ATO-1684: a live check settles at its deadline even when the child never
// closes (Windows: killing cmd.exe leaves the CLI holding the pipes).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { collectLiveCheckChild } = require("../out/main/live-check-child.js");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (sig) => { child.kills.push(sig); return true; };
  return child;
}

test("the deadline resolves the check even if `close` never fires", async () => {
  const child = fakeChild();
  const out = collectLiveCheckChild(child, 20, 1024);
  child.stdout.emit("data", Buffer.from("partial"));
  // `close` is never emitted, as when a grandchild keeps the pipes open.
  const result = await Promise.race([
    out,
    new Promise((r) => setTimeout(() => r("hung"), 1000)),
  ]);
  assert.notEqual(result, "hung");
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.stdout, "partial");
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("a late `close` after the deadline does not change the answer", async () => {
  const child = fakeChild();
  const result = await collectLiveCheckChild(child, 10, 1024);
  child.emit("close", 0);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});

test("a child that closes in time gives its exit code and output", async () => {
  const child = fakeChild();
  const out = collectLiveCheckChild(child, 5000, 1024);
  child.stdout.emit("data", Buffer.from('{"loggedIn": true}'));
  child.emit("close", 0);
  assert.deepEqual(await out, { code: 0, stdout: '{"loggedIn": true}', stderr: "", timedOut: false });
  assert.deepEqual(child.kills, []);
});

test("a spawn error is reported once", async () => {
  const child = fakeChild();
  const out = collectLiveCheckChild(child, 5000, 1024);
  child.emit("error", Object.assign(new Error("nope"), { code: "ENOENT" }));
  child.emit("close", null);
  const r = await out;
  assert.equal(r.spawnError, "ENOENT");
  assert.equal(r.timedOut, false);
});
