// Unit tests for App.waitSteady / clickSelSteady in drive.mjs (ATO-1755).
// Run: npm run test:unit
// L08 lost its Done click while Settings was still redrawing: the driver
// measured the button, a redraw moved or covered it, and the press landed on
// something else. waitSteady only lets a click go once the SAME element has
// sat at the SAME place for a quiet spell. These drive it with a fake page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "./drive.mjs";

/* A page whose answer to waitSteady's probe follows `answers`, one per read, the last one repeating. */
function fakePage(answers) {
  const app = new App(null, { port: 0, verbose: false });
  let i = 0;
  app.reads = 0;
  app.eval = async () => { app.reads += 1; const a = answers[Math.min(i, answers.length - 1)]; i += 1; return a; };
  return app;
}

test("an element that holds still is waited on for the quiet spell, then given back", async () => {
  const app = fakePage(["1@10,10,80,30"]);
  const t0 = Date.now();
  const key = await app.waitSteady("#done", { quietMs: 250, timeout: 3000 });
  assert.equal(key, "1@10,10,80,30");
  assert.ok(Date.now() - t0 >= 250, "it did not return before the quiet spell");
  assert.ok(app.reads >= 2, "one read is not a steady read");
});

test("an element rebuilt on every read (a new node each time) never counts as steady", async () => {
  let n = 0;
  const app = new App(null, { port: 0, verbose: false });
  app.eval = async () => { n += 1; return `${n}@10,10,80,30`; };
  await assert.rejects(app.waitSteady("#done", { quietMs: 250, timeout: 900 }), /stop being re-drawn/);
});

test("the quiet spell starts again when the element moves", async () => {
  const app = fakePage(["1@10,10,80,30", "1@10,10,80,30", "1@10,60,80,30", "1@10,60,80,30"]);
  const key = await app.waitSteady("#done", { quietMs: 250, timeout: 3000 });
  assert.equal(key, "1@10,60,80,30", "the click goes where the element ended up");
});

test("an element that is not there is not steady", async () => {
  const app = fakePage([null]);
  await assert.rejects(app.waitSteady("#done", { quietMs: 100, timeout: 500 }), /stop being re-drawn/);
});

test("clickSelSteady waits for stillness before it clicks", async () => {
  const app = fakePage(["2@0,0,10,10"]);
  const order = [];
  app.waitSteady = async (sel) => { order.push(`steady ${sel}`); };
  app.clickSel = async (sel) => { order.push(`click ${sel}`); return "Done"; };
  assert.equal(await app.clickSelSteady('[data-act="settings:close"]'), "Done");
  assert.deepEqual(order, ['steady [data-act="settings:close"]', 'click [data-act="settings:close"]']);
});
