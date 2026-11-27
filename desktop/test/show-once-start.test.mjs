// ATO-2401 "Show once": recording never runs without its visible menu bar item.
// main/show-once-start.ts (the order Record starts things in) against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startShowOnceCapture } = require("../out/main/show-once-start.js");

function fakeHook() {
  return { running: false, start() { this.running = true; }, stop() { this.running = false; } };
}
function fakeTray() {
  return { shown: true, destroy() { this.shown = false; } };
}

test("show once start: a menu bar item that cannot be shown leaves nothing listening", () => {
  const hook = fakeHook();
  let listenerAsked = 0;
  const r = startShowOnceCapture({
    showIndicator: () => { throw new Error("Tray: no status bar"); },
    startListener: () => { listenerAsked++; hook.start(); return hook; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "indicator");
  assert.match(r.message, /no status bar/);
  assert.equal(listenerAsked, 0, "the listener is never started without the visible item");
  assert.equal(hook.running, false, "the hook is not left running");
});

test("show once start: a listener that cannot start takes the menu bar item away", () => {
  const tray = fakeTray();
  const r = startShowOnceCapture({
    showIndicator: () => tray,
    startListener: () => { throw new Error("uiohook: no access\nstack"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "listener");
  assert.equal(r.message, "uiohook: no access");
  assert.equal(tray.shown, false, "no item claims a recording that is not happening");
});

test("show once start: the item is shown before the listener starts, and both come back", () => {
  const order = [];
  const tray = fakeTray();
  const hook = fakeHook();
  const r = startShowOnceCapture({
    showIndicator: () => { order.push("indicator"); return tray; },
    startListener: () => { order.push("listener"); hook.start(); return hook; },
  });
  assert.deepEqual(order, ["indicator", "listener"]);
  assert.equal(r.ok, true);
  assert.equal(r.hook, hook);
  assert.equal(r.indicator, tray);
  assert.equal(hook.running, true);
  assert.equal(tray.shown, true);
});
