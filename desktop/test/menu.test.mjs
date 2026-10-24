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

// ATO-544: View has Actual Size / Zoom In / Zoom Out, and none of their keys
// collides with another menu accelerator. ATO-900: ⌘0 is Actual Size, as in
// every Mac app and browser, and Toggle Sidebar moved to ⌘\.
function accelerators(items, out = []) {
  for (const i of items) {
    if (i.accelerator) out.push({ acc: i.accelerator, role: i.role, label: i.label });
    if (Array.isArray(i.submenu)) accelerators(i.submenu, out);
  }
  return out;
}

for (const platform of ["darwin", "win32", "linux"]) {
  test(`View has the zoom roles with their own keys (${platform})`, () => {
    const view = menuTemplate(() => {}, platform).find((m) => m.label === "View");
    const visible = view.submenu.filter((i) => i.visible !== false);
    const byRole = (r) => visible.find((i) => i.role === r);
    assert.equal(byRole("zoomIn").accelerator, "CommandOrControl+=");
    assert.equal(byRole("zoomOut").accelerator, "CommandOrControl+-");
    assert.equal(byRole("resetZoom").label, "Actual Size");
    assert.equal(byRole("resetZoom").accelerator, "CommandOrControl+0");
    assert.equal(view.submenu.find((i) => i.label === "Toggle Sidebar").accelerator, "CommandOrControl+\\");
    const hidden = view.submenu.filter((i) => i.visible === false).map((i) => i.accelerator);
    assert.ok(hidden.includes("CommandOrControl+Plus"), "⌘+ zooms in too");
  });

  test(`no two menu items share an accelerator (${platform})`, () => {
    const all = accelerators(menuTemplate(() => {}, platform));
    const seen = new Map();
    for (const a of all) {
      assert.ok(!seen.has(a.acc), `${a.acc} is used by both ${seen.get(a.acc)} and ${a.label || a.role}`);
      seen.set(a.acc, a.label || a.role);
    }
  });
}

// ATO-900: the page's own chords follow the menu. ⌘0 is left to Actual Size,
// and the sidebar answers ⌘\ (by the physical key on a non-Latin layout too).
test("the page maps ⌘\\ to the sidebar and leaves ⌘0 to Actual Size", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const map = src.match(/const map = \{k:'palette',[\s\S]*?\};/)[0];
  assert.match(map, /'\\\\':'toggle:sidebar'/);
  assert.doesNotMatch(map, /'0':/);
  assert.match(src, /Backslash: '\\\\'/);
  assert.doesNotMatch(src, /sidebar[^\n]*⌘ 0/, "no tooltip, palette row or sheet row names ⌘ 0 for the sidebar");
});
