// Unit tests for main/boot-paint.ts (backlog 03), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeBootPaint } = require("../out/main/boot-paint.js");

const T = 1_000_000;

test("the chat window up before the wizard is counted, and timed from the show", () => {
  // The defect: chat in the first paint, the window shown, the wizard half a second later.
  const log = {
    views: [{ view: "chat", at: T, frame: 1 }, { view: "intro", at: T + 540, frame: 33 }],
    frames: 400, input: null, done: false,
  };
  const s = summarizeBootPaint(log, T + 40, T + 9000);
  assert.equal(s.chatBeforeWizard, true);
  assert.equal(s.chatFrames, 32);
  assert.equal(s.chatShownMs, 500);
  assert.equal(s.introLeftBySelf, false);
  assert.equal(s.introMs, null);
  assert.equal(s.timeline, "chat+0 shown+40 intro+540");
});

test("a wizard in the first paint has no chat before it, and a card that left by itself is timed", () => {
  const log = {
    views: [{ view: "intro", at: T, frame: 1 }, { view: "wizard", at: T + 900, frame: 55 }],
    frames: 55, input: null, done: true,
  };
  const s = summarizeBootPaint(log, T + 30);
  assert.equal(s.chatBeforeWizard, false);
  assert.equal(s.chatFrames, 0);
  assert.equal(s.chatShownMs, 0);
  assert.equal(s.introLeftBySelf, true);
  assert.equal(s.introMs, 900);
  assert.equal(s.timeline, "intro+0 shown+30 wizard+900");
});

test("chat painted only while the window was still hidden was never seen", () => {
  const log = {
    views: [{ view: "chat", at: T, frame: 1 }, { view: "intro", at: T + 20, frame: 3 }],
    frames: 3, input: null, done: false,
  };
  const s = summarizeBootPaint(log, T + 50);
  assert.equal(s.chatBeforeWizard, true);
  assert.equal(s.chatShownMs, 0);
});

test("a card that left after an input did not leave by itself", () => {
  const log = {
    views: [{ view: "intro", at: T, frame: 1 }, { view: "wizard", at: T + 300, frame: 19 }],
    frames: 19, input: { type: "mousedown", at: T + 280 }, done: true,
  };
  const s = summarizeBootPaint(log, T + 30);
  assert.equal(s.introLeftBySelf, false);
  assert.equal(s.introMs, 300);
  assert.equal(s.input, "mousedown");
});

test("no log at all reports nothing seen rather than throwing", () => {
  const s = summarizeBootPaint(null, null);
  assert.deepEqual(
    [s.frames, s.chatBeforeWizard, s.chatFrames, s.chatShownMs, s.introLeftBySelf, s.introMs, s.timeline],
    [0, false, 0, 0, false, null, ""],
  );
});
