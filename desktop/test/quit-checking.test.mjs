// ATO-2754: a quit that waits for the agent's answer about running work says
// so in the window once the wait is longer than a glance, and takes it back
// when the answer is in. main/quit-checking.ts is tested against the built
// output (npm run build); renderer/quit-checking.js needs no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { noticeWhileChecking, QUIT_NOTICE_MS } = require("../out/main/quit-checking.js");
const R = require("../renderer/quit-checking.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a quick answer shows nothing", async () => {
  const said = [];
  const probe = Promise.resolve();
  noticeWhileChecking(probe, (on) => said.push(on), 30);
  await wait(60);
  assert.deepEqual(said, []);
});

test("a slow answer says checking, then takes it back when it comes", async () => {
  const said = [];
  let answer;
  const probe = new Promise((r) => { answer = r; });
  noticeWhileChecking(probe, (on) => said.push(on), 20);
  await wait(50);
  assert.deepEqual(said, [true]);
  answer();
  await wait(5);
  assert.deepEqual(said, [true, false]);
  assert.ok(QUIT_NOTICE_MS > 0 && QUIT_NOTICE_MS < 1500, "shorter than the probe's own bound");
});

test("a failed probe or a window that is gone never throws", async () => {
  const said = [];
  noticeWhileChecking(Promise.reject(new Error("x")), (on) => said.push(on), 10);
  noticeWhileChecking(new Promise((r) => setTimeout(r, 30)), () => { throw new Error("destroyed"); }, 5);
  await wait(60);
  assert.deepEqual(said, []);
});

test("main tells the window while the first Quit asks the agent", () => {
  const main = src("../main/main.ts");
  assert.match(main, /import \{ noticeWhileChecking \} from "\.\/quit-checking\.js";/);
  assert.match(main, /noticeWhileChecking\(quitAgentProbe, \(on\) => \{ if \(win && !win\.isDestroyed\(\)\) win\.webContents\.send\("app:quitChecking", \{ on \}\); \}\);/);
  assert.match(src("../preload/preload.ts"), /onQuitChecking: \(cb: \(payload: unknown\) => void\) => on\("app:quitChecking", cb\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('<script src="quit-checking.js">') > html.indexOf('<script src="renderer.js">'), "after renderer.js, whose toast it uses");
});

test("the window's toast comes once and goes when the check is over", () => {
  const shown = [];
  const dropped = [];
  let id = 0;
  const deps = { toast: (t, s) => { shown.push([t, s]); id++; }, lastToastId: () => id, drop: (x) => dropped.push(x) };
  R.quitCheckingApply({ on: true }, deps);
  R.quitCheckingApply({ on: true }, deps);
  assert.deepEqual(shown, [["Checking running chats…", "Asking the agent what is still running."]]);
  R.quitCheckingApply({ on: false }, deps);
  assert.deepEqual(dropped, [1]);
  R.quitCheckingApply({ on: false }, deps);
  assert.deepEqual(dropped, [1], "nothing to take back twice");
  R.quitCheckingApply(null, deps);
  assert.equal(shown.length, 1);
});
