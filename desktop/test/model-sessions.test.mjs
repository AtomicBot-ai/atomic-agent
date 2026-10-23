// ATO-418: main/model-sessions.ts and main/process-start.ts, against the
// built output (npm run build first). A marker whose pid was reused by
// another process after a crash must not keep the shared model running.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/model-sessions.js");
const P = require("../out/main/process-start.js");

const root = mkdtempSync(join(tmpdir(), "ato418-sessions-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, `d${n++}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
};

const SELF = 10;
const OTHER = 424242;

test("the desktop's marker records its start on a second line; the pid stays the first", () => {
  const dir = fresh();
  const release = S.registerModelSession(dir, SELF, () => "lstart:Fri Oct 23 08:00:00 2026");
  assert.equal(readFileSync(join(dir, "sessions", String(SELF)), "utf8"), `${SELF}\nlstart:Fri Oct 23 08:00:00 2026\n`);
  release();
  assert.equal(existsSync(join(dir, "sessions", String(SELF))), false);
});

test("where no start can be read (Windows) the marker is the bare pid, as before", () => {
  const dir = fresh();
  S.registerModelSession(dir, SELF, () => null);
  assert.equal(readFileSync(join(dir, "sessions", String(SELF)), "utf8"), String(SELF));
});

test("a marker whose pid is alive but now names a different process is stale and swept", () => {
  const dir = fresh();
  writeFileSync(join(dir, "sessions", String(OTHER)), `${OTHER}\nticks:100\n`);
  const r = S.quitMayStopModel(dir, SELF, () => true, () => "ticks:999");
  assert.deepEqual(r, { stop: true, others: [] });
  assert.equal(existsSync(join(dir, "sessions", String(OTHER))), false);
});

test("a marker whose pid is alive with the same start is a live session", () => {
  const dir = fresh();
  writeFileSync(join(dir, "sessions", String(OTHER)), `${OTHER}\nticks:100\n`);
  const r = S.quitMayStopModel(dir, SELF, () => true, () => "ticks:100");
  assert.deepEqual(r, { stop: false, others: [OTHER] });
});

test("a bare-pid marker (the terminal's) and an unreadable start keep the pid-only answer", () => {
  const dir = fresh();
  writeFileSync(join(dir, "sessions", String(OTHER)), String(OTHER));
  assert.deepEqual(S.otherLiveModelSessions(dir, SELF, () => true, () => "ticks:999"), [OTHER]);
  const dir2 = fresh();
  writeFileSync(join(dir2, "sessions", String(OTHER)), `${OTHER}\nticks:100\n`);
  assert.deepEqual(S.otherLiveModelSessions(dir2, SELF, () => true, () => null), [OTHER]);
  assert.deepEqual(S.otherLiveModelSessions(dir2, SELF, () => false, () => "ticks:100"), []);
});

test("process-start: this process has a stable start on macOS and Linux, null elsewhere", () => {
  const a = P.processStartOf(process.pid);
  if (process.platform === "darwin" || process.platform === "linux") {
    assert.match(a ?? "", /^(lstart|ticks):/);
    assert.equal(P.processStartOf(process.pid), a);
  } else {
    assert.equal(a, null);
  }
  assert.equal(P.processStartOf(process.pid, "win32"), null);
  assert.equal(P.processStartOf(-1), null);
});

test("process-start: pid file text round-trips, and liveness follows the rules", () => {
  assert.equal(P.recordedStart(P.pidFileText(5, "ticks:7")), "ticks:7");
  assert.equal(P.recordedStart(P.pidFileText(5, null)), null);
  assert.equal(P.pidFileOwnerAlive(5, "ticks:7", () => true, () => "ticks:7"), true);
  assert.equal(P.pidFileOwnerAlive(5, "ticks:7", () => true, () => "ticks:8"), false);
  assert.equal(P.pidFileOwnerAlive(5, "ticks:7", () => false, () => "ticks:7"), false);
  assert.equal(P.pidFileOwnerAlive(5, null, () => true, () => "ticks:8"), true);
  assert.equal(P.pidFileOwnerAlive(5, "ticks:7", () => true, () => null), true);
});
