// Unit tests for main/move-to-applications.ts (ATO-370), against the built output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/move-to-applications.js");

const base = { platform: "darwin", packaged: true, smoke: false, dev: false, inApplications: false };

test("a packaged mac app outside Applications is asked", () => {
  assert.equal(M.shouldOfferMove(base), true);
});

test("never asked from Applications, on other platforms, in smoke, dev or unpackaged runs, or when unknown", () => {
  assert.equal(M.shouldOfferMove({ ...base, inApplications: true }), false);
  assert.equal(M.shouldOfferMove({ ...base, inApplications: null }), false);
  assert.equal(M.shouldOfferMove({ ...base, platform: "win32" }), false);
  assert.equal(M.shouldOfferMove({ ...base, platform: "linux" }), false);
  assert.equal(M.shouldOfferMove({ ...base, smoke: true }), false);
  assert.equal(M.shouldOfferMove({ ...base, dev: true }), false);
  assert.equal(M.shouldOfferMove({ ...base, packaged: false }), false);
});

test("the question says Move and Not now, Move first, Not now on Escape", () => {
  assert.equal(M.MOVE_PROMPT.message, "Move Atomic Agent to Applications?");
  assert.deepEqual(M.MOVE_PROMPT.buttons, ["Move", "Not now"]);
  assert.equal(M.MOVE_PROMPT.defaultId, 0);
  assert.equal(M.MOVE_PROMPT.cancelId, 1);
  assert.ok(!/—/.test(M.MOVE_PROMPT.message + M.MOVE_PROMPT.detail));
});

test("Not now moves nothing", () => {
  let moved = 0;
  const out = M.offerMove({ ask: () => 1, move: () => { moved++; return true; }, log: () => {} });
  assert.equal(out, "declined");
  assert.equal(moved, 0);
});

test("Move moves", () => {
  assert.equal(M.offerMove({ ask: () => 0, move: () => true, log: () => {} }), "moved");
});

test("a refused or failing move is logged and the launch goes on", () => {
  const lines = [];
  assert.equal(M.offerMove({ ask: () => 0, move: () => false, log: (l) => lines.push(l) }), "failed");
  assert.equal(M.offerMove({ ask: () => 0, move: () => { throw new Error("no permission"); }, log: (l) => lines.push(l) }), "failed");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /no permission/);
});
