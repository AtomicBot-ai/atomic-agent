// ATO-279: Help › "Report an Issue…" opened the issue list straight from main,
// so nothing was counted. It now sends the `help.report` act like the in-app
// button, which the renderer counts as a ui_action (via: menu).
// Against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { menuTemplate } = require("../out/main/menu.js");

function helpItem(platform, label) {
  const sent = [];
  const help = menuTemplate((c) => sent.push(c), platform).find((m) => m.label === "Help");
  const it = help.submenu.find((i) => i.label === label);
  return { it, sent };
}

for (const platform of ["darwin", "win32", "linux"]) {
  test(`Help › Report an Issue… sends help.report (${platform})`, () => {
    const { it, sent } = helpItem(platform, "Report an Issue…");
    assert.ok(it, "the Help menu has Report an Issue…");
    it.click();
    assert.deepEqual(sent, ["help.report"]);
  });
}

test("the renderer counts the act and lets it through over first-run setup", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");
  assert.match(acts, /'help\.report':L/, "help.report is on the ui_action allowlist");
  assert.match(src, /BR\.onMenu\(\(command\) => \{[\s\S]*?ANX\.via\('menu'\); act\(command\);/, "menu commands go through act with via: menu");
  assert.match(src, /if \(OB\.open && a === 'help\.report'\) \{ helpReport\(\); return; \}\n    if \(OB\.open\) return;/);
});
