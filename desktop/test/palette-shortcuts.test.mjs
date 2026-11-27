// ATO-2001 (and ATO-1761 before it): a palette row drew a chord that nothing
// bound. "List built-in tools" showed ⌥⌘T and "Show session id" ⌃⌘C, while
// menu.ts has Option chords for 0, F, E and K only and the page's own ⌘ map
// has neither key. VS Code's palette prints a keybinding only when the
// keybinding registry has one; this test holds the catalogue to the same
// rule: every chord in PAL's fourth slot must be live in the menu template
// (out/main/menu.js, so build first, as menu.test.mjs does) or in
// renderer.js's keydown handler. A slash alias ('/bug') is not a chord.
// ATO-2521: the rule holds per platform. The Quit row drew ⌘Q, which kbd()
// prints as "Ctrl Q" on Windows, where Electron's quit role has no
// accelerator; so the catalogue is checked against the macOS, Windows and
// Linux templates, each hint spelled as that platform's kbd() draws it.
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
const kbdSource = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name && n.name.text === "kbd");
assert.ok(kbdSource, "renderer.js keeps kbd(), the chord as each platform spells it");

const PLATFORMS = ["darwin", "win32", "linux"];

/** The renderer's platform globals, as renderer.js derives them from BR.platform. */
function pageContext(platform) {
  return vm.createContext({ PLATFORM: platform, IS_MAC: platform === "darwin", IS_WIN: platform === "win32" });
}

/** The palette catalogue as the page has it on `platform`: [icon, title, context, chord or alias, act], plus the hint as drawn. */
function paletteRows(platform = "darwin") {
  const c = pageContext(platform);
  // A top-level `const` is not a property of the vm's global; the script's completion value hands it out.
  const PAL = vm.runInContext(consts.get("PAL") + "; PAL", c);
  const kbd = vm.runInContext(kbdSource.getText(ast) + "; kbd", c);
  const rows = [];
  for (const [, items] of PAL) for (const r of items) rows.push({ title: r[1], hint: r[3], drawn: kbd(r[3]), act: r[4] });
  return rows;
}

/* One spelling per platform. macOS: the glyphs the page writes ('⌥ ⌘ E').
   Windows and Linux: the words kbd() prints there ('Ctrl Shift E'). */
const SPELL = {
  mac: { names: { Alt: "⌥", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Command: "⌘", Control: "⌃", Shift: "⇧" }, order: ["⌃", "⌥", "⇧", "⌘"], mod: "⌘", shift: "⇧" },
  off: { names: { Alt: "Alt", CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Control: "Ctrl", Ctrl: "Ctrl", Shift: "Shift" }, order: ["Ctrl", "Shift", "Alt"], mod: "Ctrl", shift: "Shift" },
};
const spellOf = (platform) => (platform === "darwin" ? SPELL.mac : SPELL.off);

/** Modifiers in a fixed order, then the key in upper case. */
function canon(tokens, sp) {
  const mods = tokens.filter((t) => sp.order.includes(t)).sort((a, b) => sp.order.indexOf(a) - sp.order.indexOf(b));
  const keys = tokens.filter((t) => !sp.order.includes(t)).map((k) => k.toUpperCase());
  return mods.concat(keys).join(" ");
}
const canonDrawn = (drawn, sp) => canon(drawn.split(/\s+/).filter(Boolean), sp);
const canonAccelerator = (acc, sp) => canon(acc.split("+").map((p) => sp.names[p] || p), sp);

/** act -> the chords that run it on `platform`. */
function liveBindings(platform) {
  const sp = spellOf(platform);
  const out = new Map();
  const add = (act, chord) => { if (!out.has(act)) out.set(act, new Set()); out.get(act).add(chord); };

  // The menu bar: each item with an accelerator, and the command its click
  // sends. menuTemplate takes one `send`, so `sent` is swapped per item.
  let sent = null;
  const template = menuTemplate((cmd) => { if (sent) sent.push(cmd); }, platform);
  const walk = (items) => {
    for (const it of items) {
      if (it.accelerator && typeof it.click === "function") {
        sent = [];
        it.click();
        for (const cmd of sent) add(cmd, canonAccelerator(it.accelerator, sp));
        sent = null;
      }
      /* The quit role with no accelerator of its own takes Electron's default
         (lib/browser/api/menu-item-roles.ts): CommandOrControl+Q on macOS and
         Linux, none on Windows, where Alt+F4 closes the window instead. */
      if (it.role === "quit") {
        if (it.accelerator) add("quit", canonAccelerator(it.accelerator, sp));
        else if (platform !== "win32") add("quit", canonAccelerator("CommandOrControl+Q", sp));
      }
      if (Array.isArray(it.submenu)) walk(it.submenu);
    }
  };
  walk(template);

  // The page's own chords (renderer.js keydown, `mod` is ⌘ or Ctrl): the map ⌘K, ⌘1-4, ⌘N and the rest run through.
  const mapSrc = source.match(/const map = (\{k:'palette',[\s\S]*?\});/);
  assert.ok(mapSrc, "renderer.js keeps the keydown's ⌘ map (const map = {k:'palette', ...})");
  const map = vm.runInContext("(" + mapSrc[1] + ")", vm.createContext({}));
  for (const [key, act] of Object.entries(map)) add(act, canon([sp.mod, key], sp));
  // ...and the one ⇧⌘ chord written out by hand next to it.
  for (const m of source.matchAll(/mod && e\.shiftKey && sk\.toLowerCase\(\) === '(\w)'\) \{[^\n]*?act\('([^']+)'\)/g)) {
    add(m[2], canon([sp.shift, sp.mod, m[1]], sp));
  }
  return out;
}

const isChord = (hint) => typeof hint === "string" && hint.length > 0 && !hint.startsWith("/");

function deadHints(platform) {
  const sp = spellOf(platform);
  const bound = liveBindings(platform);
  const dead = [];
  for (const r of paletteRows(platform)) {
    if (!isChord(r.hint)) continue;
    const live = bound.get(r.act);
    if (!live || !live.has(canonDrawn(r.drawn, sp))) dead.push(`${r.title}: ${r.drawn} (${r.act})`);
  }
  return dead;
}

for (const platform of PLATFORMS) {
  test(`the palette draws a chord only where one is bound (${platform})`, () => {
    assert.deepEqual(deadHints(platform), [], `every chord printed in the palette runs its row on ${platform}`);
  });
}

test("the catalogue still carries live chords, so the check is not vacuous", () => {
  for (const platform of PLATFORMS) {
    const withChord = paletteRows(platform).filter((r) => isChord(r.hint)).map((r) => r.act);
    for (const act of ["room:chat", "session:new", "toggle:sidebar", "cards:expand", "toggle:files"]) {
      assert.ok(withChord.includes(act), `${act} keeps its chord in the palette on ${platform}`);
    }
  }
});

test("List built-in tools and Show session id carry no chord (ATO-2001)", () => {
  const byAct = new Map(paletteRows().map((r) => [r.act, r]));
  assert.equal(byAct.get("tools").hint, "", "List built-in tools: no ⌥⌘T, nothing binds it");
  assert.equal(byAct.get("session:id").hint, "", "Show session id: no ⌃⌘C, nothing binds it");
});

test("the Quit row matches the menu's quit item on each platform (ATO-2521)", () => {
  const quit = (platform) => paletteRows(platform).find((r) => r.act === "quit");
  assert.deepEqual([quit("darwin").title, quit("darwin").drawn], ["Quit", "⌘ Q"], "macOS: Quit, ⌘Q");
  assert.deepEqual([quit("win32").title, quit("win32").hint], ["Exit", ""], "Windows: File › Exit, no Ctrl+Q (the quit role has none there)");
  assert.deepEqual([quit("linux").title, quit("linux").drawn], ["Exit", "Ctrl Q"], "Linux: File › Exit, Ctrl+Q from the role");
  // The label is the menu's own: File › Exit off macOS (menu.ts).
  for (const platform of ["win32", "linux"]) {
    const file = menuTemplate(() => {}, platform).find((m) => m.label === "File");
    assert.ok(file.submenu.some((it) => it.role === "quit" && it.label === "Exit"), `${platform}: File › Exit is the quit item`);
  }
});
