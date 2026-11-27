// ATO-1734: ChildProcessGone and RenderProcessGone say whether the app was
// quitting and how much memory the machine had free, as words from a fixed
// list (main/sentry/handlers.ts), against the built output (npm run build first).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module, { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

// handlers.ts listens on Electron's `app`: a stand-in, so plain Node can load it.
const fakeApp = new EventEmitter();
const STUB = "electron-stub-ato-1734";
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "electron" ? STUB : realResolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { app: fakeApp } };

const QUITTING = new Set(["yes", "no"]);
const FREE_MEM = new Set(["lt_512m", "lt_1g", "lt_2g", "lt_4g", "gte_4g"]);
const MB = 1_048_576;

// Analytics on, a DSN set, fetch caught: every envelope's event lands in `events`.
const root = mkdtempSync(join(tmpdir(), "desk-sentry-moment-"));
const desk = join(root, "desktop");
const tui = join(root, "tui");
mkdirSync(desk, { recursive: true });
mkdirSync(tui, { recursive: true });
writeFileSync(join(desk, "config.json"), JSON.stringify({ analytics: { enabled: true } }));
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const events = [];
process.env.ATOMIC_AGENT_INSTALL_ID_FILE = join(root, "install-id");
process.env.ATOMIC_DESKTOP_SENTRY_DSN = "https://pub@o1.ingest.sentry.io/7";
delete process.env.DO_NOT_TRACK;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/envelope/")) events.push(JSON.parse(String(init.body).split("\n")[2]));
  return { ok: true, status: 200 };
};
require("../out/main/analytics/core.js").initAnalytics({ stateDir: desk, tuiStateDir: tui, freshState: true, testRun: false });
const H = require("../out/main/sentry/handlers.js");

after(() => {
  globalThis.fetch = savedFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

const sent = (source, reason) => events.find((e) => e.tags?.source === source && e.tags?.reason === reason);

function fakeWindow() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  return win;
}

test("a child process gone while quitting, short of memory: app_quitting yes, free_mem lt_512m", () => {
  H.wireProcessErrorReporting({ quitting: () => true, freeMemBytes: () => 300 * MB });
  fakeApp.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 5 });
  const ev = sent("child-process-gone", "crashed");
  assert.ok(ev, "a ChildProcessGone event was sent");
  assert.equal(ev.tags.app_quitting, "yes");
  assert.equal(ev.tags.free_mem, "lt_512m");
  assert.ok(QUITTING.has(ev.tags.app_quitting) && FREE_MEM.has(ev.tags.free_mem));
  // The figure itself never leaves: only the bucket.
  assert.doesNotMatch(JSON.stringify(ev), /314572800/);
});

test("a window's renderer gone while running, plenty of memory: app_quitting no, free_mem gte_4g", () => {
  const win = fakeWindow();
  H.wireWindowErrorReporting(win, () => true, { quitting: () => false, freeMemBytes: () => 6 * 1024 * MB });
  win.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 1 });
  const ev = sent("render-process-gone", "oom");
  assert.ok(ev, "a RenderProcessGone event was sent");
  assert.equal(ev.tags.app_quitting, "no");
  assert.equal(ev.tags.free_mem, "gte_4g");
  assert.ok(QUITTING.has(ev.tags.app_quitting) && FREE_MEM.has(ev.tags.free_mem));
  assert.equal(ev.tags.recovered, "yes");
});

test("an unknown quit state or memory figure sends no tag rather than a guess", () => {
  const win = fakeWindow();
  H.wireWindowErrorReporting(win, () => null, { quitting: () => { throw new Error("x"); }, freeMemBytes: () => Number.NaN });
  win.webContents.emit("render-process-gone", {}, { reason: "abnormal-exit", exitCode: 2 });
  const ev = sent("render-process-gone", "abnormal-exit");
  assert.ok(ev, "a RenderProcessGone event was sent");
  assert.equal(ev.tags.app_quitting, undefined);
  assert.equal(ev.tags.free_mem, undefined);
});
