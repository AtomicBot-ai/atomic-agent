// Unit tests for main/stdio-guard.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-1280: a closed stdout/stderr (Linux AppImage) must not end the app with EPIPE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { guardStream, isClosedStreamError } = require("../out/main/stdio-guard.js");

function epipe() {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

/** A stream double: write() records, and can be told to fail like a closed pipe. */
function fakeStream() {
  const s = new EventEmitter();
  s.written = [];
  s.failSync = false;
  s.write = function (chunk, cb) {
    if (this.failSync) throw epipe();
    this.written.push(String(chunk));
    if (typeof cb === "function") cb(null);
    return true;
  };
  return s;
}

test("EPIPE and friends count as a closed reader, other errors do not", () => {
  assert.equal(isClosedStreamError(epipe()), true);
  assert.equal(isClosedStreamError({ code: "ERR_STREAM_DESTROYED" }), true);
  assert.equal(isClosedStreamError({ code: "ENOSPC" }), false);
  assert.equal(isClosedStreamError(new Error("plain")), false);
  assert.equal(isClosedStreamError(null), false);
});

test("an async EPIPE 'error' event is swallowed instead of becoming uncaught", () => {
  const s = fakeStream();
  guardStream(s);
  // Without a listener, emit('error') throws: that is the crash in Sentry.
  assert.doesNotThrow(() => s.emit("error", epipe()));
  // After the pipe is gone, writes are dropped quietly.
  assert.equal(s.write("after\n"), true);
  assert.deepEqual(s.written, []);
});

test("a write that throws EPIPE synchronously does not throw out of console", () => {
  const s = fakeStream();
  guardStream(s);
  s.failSync = true;
  assert.doesNotThrow(() => s.write("line\n"));
  s.failSync = false;
  assert.equal(s.write("later\n"), true);
  assert.deepEqual(s.written, [], "the stream stays dead once its reader is gone");
});

test("a write callback still fires on a dead stream", async () => {
  const s = fakeStream();
  guardStream(s);
  s.emit("error", epipe());
  await new Promise((resolve) => s.write("x", resolve));
});

test("writes go through normally while the reader is alive", () => {
  const s = fakeStream();
  guardStream(s);
  s.write("one\n");
  s.write("two\n");
  assert.deepEqual(s.written, ["one\n", "two\n"]);
});

test("an error that is not a closed reader is handed on, not hidden", () => {
  const s = fakeStream();
  const other = [];
  guardStream(s, (err) => other.push(err.code));
  s.emit("error", Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  assert.deepEqual(other, ["ENOSPC"]);
});

test("guarding twice adds one listener", () => {
  const s = fakeStream();
  guardStream(s);
  guardStream(s);
  assert.equal(s.listenerCount("error"), 1);
});
