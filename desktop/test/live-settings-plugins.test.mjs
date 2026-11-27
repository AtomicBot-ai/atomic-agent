// Unit tests for live/settings-plugins.mjs, the shared Settings › Plugins
// steps of the live scenarios L07, L08, L22 (ATO-2439, after ATO-1755).
// Run: npm run test:unit
// A click right after plugins.json lands (written by the CLI, a separate
// process) can hit a pane that is still redrawing. These check the "pane
// settled" test itself, the order of the shared steps, and that the three
// scenarios use them instead of a plain click.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PANE_SETTLED, closeSettings, openPluginsPane, paneSettled } from "./live/settings-plugins.mjs";

const LIVE = join(dirname(fileURLToPath(import.meta.url)), "live");

/* PANE_SETTLED run against a page that has exactly the `present` selectors. */
function settledWith(present) {
  const document = { querySelector: (sel) => (present.includes(sel) ? {} : null) };
  return new Function("document", `return (${PANE_SETTLED});`)(document);
}
const REFRESH = '[data-act="plugins:refresh"]';

test("the pane counts as settled only when nothing in it is still working", () => {
  assert.equal(settledWith([REFRESH]), true, "Refresh there and free, no spinner, no question");
  assert.equal(settledWith([]), false, "the pane is not drawn yet");
  assert.equal(settledWith([REFRESH, '[data-act="plugins:refresh"][disabled]']), false, "a list read is running");
  assert.equal(settledWith([REFRESH, ".set-plgrow .tk-spin"]), false, "a write is running on a row");
  assert.equal(settledWith([REFRESH, "#settings .set-overlay"]), false, "a question is still open");
});

/* An app that records what the steps ask of it. */
function recorder() {
  const calls = [];
  return {
    calls,
    clickSelSteady: async (sel) => { calls.push(["steady", sel]); },
    clickSel: async (sel) => { calls.push(["plain", sel]); },
    waitFor: async (expr, what, opts) => { calls.push(["wait", expr, what, opts]); return true; },
  };
}

test("paneSettled waits on PANE_SETTLED and says what it waited for", async () => {
  const app = recorder();
  await paneSettled(app, "after the consent");
  assert.deepEqual(app.calls, [["wait", PANE_SETTLED, "Settings › Plugins done redrawing after the consent", { timeout: 30000 }]]);
});

test("openPluginsPane clicks only once things hold still, then waits for the row and for the pane to settle", async () => {
  const app = recorder();
  await openPluginsPane(app, "a-live-kit");
  assert.deepEqual(app.calls.map((c) => c.slice(0, 2)).slice(0, 2), [
    ["steady", ".sb-settings"],
    ["steady", 'button.setrow[data-act="settings:plugins"]'],
  ]);
  assert.equal(app.calls[2][0], "wait");
  assert.match(app.calls[2][1], /"a-live-kit"/, "it waits for the named plugin's row");
  assert.equal(app.calls[3][1], PANE_SETTLED, "and then for the pane to stop redrawing");
  assert.equal(app.calls.length, 4);
  assert.ok(!app.calls.some((c) => c[0] === "plain"), "no plain click");
});

test("closeSettings presses Done once it holds still and waits for Settings to be gone", async () => {
  const app = recorder();
  await closeSettings(app);
  assert.deepEqual(app.calls.map((c) => c.slice(0, 2)), [
    ["steady", '[data-act="settings:close"]'],
    ["wait", "!document.querySelector('#settings')"],
  ]);
});

/* A plain click on a Settings or Plugins control in these scenarios is the
   ATO-2439 gap coming back. */
const SETTINGS_CLICK = /app\.clickSel\([^)]*(settings:|plugins:|sb-settings|agent:restart)/;

for (const file of ["L07-claude-plugin-loads.mjs", "L08-hook-blocks-a-tool.mjs", "L22-dangerous-plugin-refused.mjs"]) {
  test(`${file} uses the shared settled steps, not a plain click into Settings`, () => {
    const src = readFileSync(join(LIVE, file), "utf8");
    assert.match(src, /from '\.\/settings-plugins\.mjs'/, "it imports the shared steps");
    assert.ok(!/const PANE_SETTLED\b/.test(src), "it keeps no copy of PANE_SETTLED of its own");
    const plain = src.split("\n").filter((l) => SETTINGS_CLICK.test(l));
    assert.deepEqual(plain, [], "plain clicks on Settings controls");
  });
}
