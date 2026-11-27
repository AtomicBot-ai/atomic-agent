// ATO-2741: the desktop pet (ATO-2391) could only be turned on from View ›
// Desktop Pet › Show Pet, and Windows may have no menu bar. Settings ›
// General has a Desktop pet switch and the ⌘K palette a Show / Hide desktop
// pet row; both go through main's own toggle (the menu's), and main sends
// every change back so the switch, the row and the menu checkbox agree.
//
// renderer/pet-settings.js is required (its pure half); renderer.js, the
// preload, main and the pages are read as text. No build.
// Run: node --test test/pet-settings.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const S = require("../renderer/pet-settings.js");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const renderer = read("../renderer/renderer.js");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** renderer.js's own switch, so the row is drawn the way Settings draws it. */
function setSwitchHTML(o) {
  const at = renderer.indexOf("\nfunction setSwitchHTML(");
  assert.ok(at >= 0, "setSwitchHTML is a top-level function in renderer.js");
  const c = vm.createContext({ esc });
  vm.runInContext(renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2), c);
  return c.setSwitchHTML(o);
}
const h = { esc, setSwitchHTML };

test("Settings row: a Desktop pet switch wired to the pet's toggle", () => {
  const off = S.petSettingsRowHTML({ info: { enabled: false, dnd: false }, busy: false, error: null }, h);
  assert.match(off, /<div class="t">Desktop pet<\/div>/);
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.match(off, /data-act="petset:toggle"/);
  assert.match(off, /title="Show the desktop pet"/);
  assert.doesNotMatch(off, / disabled/);
  const on = S.petSettingsRowHTML({ info: { enabled: true, dnd: false }, busy: false, error: null }, h);
  assert.match(on, /class="tk-switch on" role="switch" aria-checked="true"/);
  assert.match(on, /title="Hide the desktop pet"/);
});

test("Settings row: disabled until main answers, busy while it changes, a plain error", () => {
  assert.match(S.petSettingsRowHTML({ info: null, busy: false, error: null }, h), /data-act="petset:toggle"[^>]* disabled/);
  const busy = S.petSettingsRowHTML({ info: { enabled: false }, busy: true, error: null }, h);
  assert.match(busy, /tk-spin/);
  assert.match(busy, / disabled/);
  const err = S.petSettingsRowHTML({ info: { enabled: false }, busy: false, error: "The desktop pet could not be changed. Try again." }, h);
  assert.match(err, /tk-help--warn" role="status">The desktop pet could not be changed\. Try again\./);
  assert.doesNotMatch(read("../renderer/pet-settings.js"), /\u2014/, "no long dash in the UI text");
});

test("renderer.js draws the row in Settings › General and reads the state there", () => {
  const at = renderer.indexOf("\nfunction generalPane(");
  const body = renderer.slice(at, renderer.indexOf("\n}\n", at));
  assert.match(body, /\+ petSettingsRowHTML\(PETSET, \{esc, setSwitchHTML\}\)/);
  assert.match(renderer, /if \(pane === 'general'\) petSettingsRefresh\(\);/);
  assert.match(renderer, /if \(a\.startsWith\('petset:'\)\) \{ close\(\); petSettingsAct\(a\.slice\('petset:'\.length\)\); return; \}/);
  assert.match(renderer, /\n  petSettingsBoot\(\);/, "it follows changes from the start");
});

/** The palette catalogue as the page has it (palette-shortcuts.test.mjs reads it the same way). */
function palette() {
  const at = renderer.indexOf("\nconst PAL = [");
  assert.ok(at >= 0, "PAL is a top-level const in renderer.js");
  const text = renderer.slice(at + 1, renderer.indexOf("\n];", at) + 3);
  return vm.runInContext(text + "; PAL", vm.createContext({}));
}

test("the palette has the pet's row, and its title says what a click does", () => {
  const PAL = palette();
  const rows = PAL.flatMap(([, items]) => items);
  const row = rows.find((r) => r[4] === S.PET_PAL_ACT);
  assert.ok(row, "a palette row runs petset:toggle");
  assert.equal(row[1], "Show desktop pet", "the pet is off by default");
  assert.equal(row[3], "", "no chord drawn: nothing binds one");
  assert.equal(S.petPaletteSync(PAL, true), true);
  assert.equal(row[1], "Hide desktop pet");
  S.petPaletteSync(PAL, false);
  assert.equal(row[1], "Show desktop pet");
  assert.equal(S.petPaletteSync([["Go", [["x", "y", "", "", "other"]]]], true), false);
  assert.equal(S.petPaletteSync(null, true), false);
});

test("the preload exposes the pet's state to the main window", () => {
  const preload = read("../preload/preload.ts");
  assert.match(preload, /petPrefs: \(\) => ipcRenderer\.invoke\("pet:prefsGet"\)/);
  assert.match(preload, /petSetEnabled: \(on: boolean\) => ipcRenderer\.invoke\("pet:setEnabled", on === true\)/);
  assert.match(preload, /onPetPrefs: \(cb: \(payload: unknown\) => void\) => on\("pet:prefsChanged", cb\)/);
});

test("main: the switch uses the menu's toggle, and every change reaches the main window", () => {
  const ipc = read("../main/pet-ipc.ts");
  assert.match(ipc, /ipcMain\.handle\("pet:prefsGet", \(event\) => \(isMain\(event\.sender\) \? shown\(\) : null\)\);/);
  assert.match(ipc, /ipcMain\.handle\("pet:setEnabled"/);
  assert.match(ipc, /if \(!isMain\(event\.sender\) \|\| typeof on !== "boolean"\) return null;/, "only the main window, only a boolean");
  assert.match(ipc, /setEnabled\(on\) \{\n\s*if \(prefs\.enabled !== on\) hub\.toggle\(\);/, "the same toggle as View › Desktop Pet");
  assert.match(ipc, /main\.webContents\.send\("pet:prefsChanged", shown\(\)\)/);
  // The menu checkbox, the pet's own Hide Pet and Settings all end in changed(): menu rebuilt, window told.
  const toggle = ipc.slice(ipc.indexOf("    toggle() {"), ipc.indexOf("    setEnabled(on) {"));
  assert.match(toggle, /changed\(\);/);
  assert.doesNotMatch(toggle, /w\.menuChanged\(\);/, "menuChanged runs inside changed()");
  assert.match(ipc, /const changed = \(\) => \{\n\s*w\.menuChanged\(\);/);
  const main = read("../main/main.ts");
  assert.match(main, /if \(command === "pet:toggle"\) \{ petHub\?\.toggle\(\); return; \}/, "the menu still goes through the hub");
});

test("the main window loads pet-settings.js before renderer.js; analytics keeps the act's word", () => {
  const index = read("../renderer/index.html");
  const at = index.indexOf('<script src="pet-settings.js"></script>');
  assert.ok(at >= 0 && at < index.indexOf('<script src="renderer.js"></script>'));
  assert.match(read("../renderer/analytics-acts.js"), /petset:\{toggle:L\}/);
});
