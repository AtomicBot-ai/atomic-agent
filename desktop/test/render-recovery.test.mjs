// ATO-765: main/render-recovery.ts, against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RenderRecovery, MAX_RELOADS, RELOAD_WINDOW_MS, KEEPS_CRASHING } = require("../out/main/render-recovery.js");

test("a crashed page is reloaded at most twice a minute, then the person is asked", () => {
  let now = 1_000;
  const r = new RenderRecovery(() => now);
  assert.equal(MAX_RELOADS, 2);
  assert.equal(r.onGone(), "reload");
  now += 5_000;
  assert.equal(r.onGone(), "reload");
  now += 5_000;
  assert.equal(r.onGone(), "ask");
  // Asking does not spend the budget: a fourth crash right after still asks, it never loops.
  assert.equal(r.onGone(), "ask");
});

test("crashes older than the window no longer count", () => {
  let now = 0;
  const r = new RenderRecovery(() => now);
  assert.equal(r.onGone(), "reload");
  now += 10_000;
  assert.equal(r.onGone(), "reload");
  now = RELOAD_WINDOW_MS + 1; // the first crash has aged out, the second has not
  assert.equal(r.onGone(), "reload");
  assert.equal(r.onGone(), "ask");
});

test("choosing Reload in the dialog starts the budget over", () => {
  const now = 0;
  const r = new RenderRecovery(() => now);
  r.onGone(); r.onGone();
  assert.equal(r.onGone(), "ask");
  r.reset();
  assert.equal(r.onGone(), "reload");
});

test("the dialog offers Reload then Quit, with no em dash in its text", () => {
  assert.deepEqual([...KEEPS_CRASHING.buttons], ["Reload", "Quit"]);
  assert.equal(KEEPS_CRASHING.message, "The window keeps crashing");
  assert.ok(!/—/.test(KEEPS_CRASHING.message + KEEPS_CRASHING.detail));
});
