// ATO-2001 (and ATO-1761 before it): a palette row drew a chord that nothing
// bound. "List built-in tools" showed ⌥⌘T and "Show session id" ⌃⌘C, while
// menu.ts has Option chords for 0, F, E and K only and the page's own ⌘ map
// has neither key. VS Code's palette prints a keybinding only when the
// keybinding registry has one; this test holds the catalogue to the same
// rule: every chord in PAL's fourth slot must be live in the macOS menu
// template (out/main/menu.js, so build first, as menu.test.mjs does) or in
// renderer.js's keydown handler. A slash alias ('/bug') is not a chord.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { menuTemplate } = require("../out/main/menu.js");

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const ast = ts.createSourceFile("renderer.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const consts = new Map(ast.statements.filter(ts.isVariableStatement)
  .flatMap((n) => n.declarationList.declarations.map((d) => [d.name.getText(ast), n.getText(ast)])));

/** The palette catalogue as the page has it: [icon, title, context, chord or alias, act]. */
function paletteRows() {
  // A top-level `const` is not a property of the vm's global; the script's completion value hands it out.
  const PAL = vm.runInContext(consts.get("PAL") + "; PAL", vm.createContext({}));
  const rows = [];
  for (const [, items] of PAL) for (const r of items) rows.push({ title: r[1], hint: r[3], act: r[4] });
  return rows;
}

const GLYPH = { Alt: "⌥", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Command: "⌘", Control: "⌃", Shift: "⇧" };
const ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** One spelling for '⌥ ⌘ E' and 'Alt+CommandOrControl+E' alike: modifiers in a fixed order, then the key in upper case. */
function canon(tokens) {
  const mods = tokens.filter((t) => ORDER.includes(t)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const keys = tokens.filter((t) => !ORDER.includes(t)).map((k) => k.toUpperCase());
  return mods.concat(keys).join(" ");
}
const canonHint = (hint) => canon(hint.split(/\s+/).filter(Boolean));
const canonAccelerator = (acc) => canon(acc.split("+").map((p) => GLYPH[p] || p));

/** act -> the chords that run it. */
function liveBindings() {
  const out = new Map();
  const add = (act, chord) => { if (!out.has(act)) out.set(act, new Set()); out.get(act).add(chord); };

  // The macOS menu bar: each item with an accelerator, and the command its
  // click sends. menuTemplate takes one `send`, so `sent` is swapped per item.
  let sent = null;
  const template = menuTemplate((cmd) => { if (sent) sent.push(cmd); }, "darwin");
  const walk = (items) => {
    for (const it of items) {
      if (it.accelerator && typeof it.click === "function") {
        sent = [];
        it.click();
        for (const cmd of sent) add(cmd, canonAccelerator(it.accelerator));
        sent = null;
      }
      // Electron gives the quit role Command+Q on macOS without an accelerator of its own.
      if (it.role === "quit") add("quit", canon(["⌘", "Q"]));
      if (Array.isArray(it.submenu)) walk(it.submenu);
    }
  };
  walk(template);

  // The page's own ⌘ chords (renderer.js keydown): the map ⌘K, ⌘1-4, ⌘N and the rest run through.
  const mapSrc = source.match(/const map = (\{k:'palette',[\s\S]*?\});/);
  assert.ok(mapSrc, "renderer.js keeps the keydown's ⌘ map (const map = {k:'palette', ...})");
  const map = vm.runInContext("(" + mapSrc[1] + ")", vm.createContext({}));
  for (const [key, act] of Object.entries(map)) add(act, canon(["⌘", key]));
  // ...and the one ⇧⌘ chord written out by hand next to it.
  for (const m of source.matchAll(/mod && e\.shiftKey && sk\.toLowerCase\(\) === '(\w)'\) \{[^\n]*?act\('([^']+)'\)/g)) {
    add(m[2], canon(["⇧", "⌘", m[1]]));
  }
  return out;
}

const isChord = (hint) => typeof hint === "string" && hint.length > 0 && !hint.startsWith("/");

test("the palette draws a chord only where one is bound", () => {
  const rows = paletteRows();
  const bound = liveBindings();
  const dead = [];
  for (const r of rows) {
    if (!isChord(r.hint)) continue;
    const live = bound.get(r.act);
    if (!live || !live.has(canonHint(r.hint))) dead.push(`${r.title}: ${r.hint} (${r.act})`);
  }
  assert.deepEqual(dead, [], "every chord printed in the palette runs its row");
});

test("the catalogue still carries live chords, so the check is not vacuous", () => {
  const rows = paletteRows();
  const withChord = rows.filter((r) => isChord(r.hint)).map((r) => r.act);
  for (const act of ["room:chat", "session:new", "toggle:sidebar", "cards:expand", "toggle:files"]) {
    assert.ok(withChord.includes(act), `${act} keeps its chord in the palette`);
  }
});

test("List built-in tools and Show session id carry no chord (ATO-2001)", () => {
  const byAct = new Map(paletteRows().map((r) => [r.act, r]));
  assert.equal(byAct.get("tools").hint, "", "List built-in tools: no ⌥⌘T, nothing binds it");
  assert.equal(byAct.get("session:id").hint, "", "Show session id: no ⌃⌘C, nothing binds it");
});
