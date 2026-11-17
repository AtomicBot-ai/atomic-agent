// ATO-1032: the cheap habits of the best desktop apps — starter cards on
// an empty chat, the Stop chord as the platform presses it, the New chat
// chord on its row, and a short age on each chat row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

test("a chat row's age reads short", () => {
  const now = Date.now();
  const c = vm.createContext({ Date });
  vm.runInContext(fn("chatAgeShort") + "globalThis.age = chatAgeShort;", c);
  assert.equal(c.age(0), "");
  assert.equal(c.age(now - 10 * 1000), "now");
  assert.equal(c.age(now - 5 * 60000), "5m");
  assert.equal(c.age(now - 2 * 3600000), "2h");
  assert.equal(c.age(now - 3 * 86400000), "3d");
  assert.equal(c.age(now - 15 * 86400000), "2w");
});

test("the ages move on without a re-render", () => {
  const now = Date.now();
  const row = { dataset: { at: String(now - 10 * 1000), m: "now" } };
  const root = { querySelectorAll: (sel) => (sel === ".sesrow[data-age][data-at]" ? [row] : []) };
  const c = vm.createContext({ Date, Number, root });
  vm.runInContext(fn("chatAgeShort") + fn("refreshChatAges") + "globalThis.refresh = refreshChatAges;", c);
  c.refresh(root);
  assert.equal(row.dataset.m, "now");
  row.dataset.at = String(now - 31 * 60000);
  c.refresh(root);
  assert.equal(row.dataset.m, "31m");
  assert.match(fn("chatRow"), /data-at="' \+ Number\(s\.updatedAt\)/);
  assert.match(fn("chatRow"), /if \(age\) ensureChatAgeTick\(\);/);
});

test("the row carries the age only where nothing is queued", () => {
  const row = fn("chatRow");
  assert.match(row, /const age = queued \? '' : chatAgeShort\(s\.updatedAt\);/);
  assert.match(row, /data-m="' \+ queued \+ ' queued" data-queued=/);
});

test("the platform's Stop chord, New chat's chord on the row", () => {
  assert.doesNotMatch(source, /title="Stop \(Ctrl\+\.\)"/);
  assert.match(source, /kbdText\('Stop \(⌘ \.\)'\)/);
  assert.match(source, /class="sb-new" data-act="session:new" data-kbd=/);
});

// The empty chat's four starter cards (EMPTY_STARTERS): a card fills the
// composer, never sends; Images and Video open their Studio page when it is
// registered and fill the composer when it is not.
function starters(studioPages) {
  const at = source.indexOf("\nconst EMPTY_STARTERS = [");
  assert.ok(at >= 0, "EMPTY_STARTERS is a top-level const in renderer.js");
  const list = source.slice(at + 1, source.indexOf("\n];\n", at) + 4);
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const c = vm.createContext({ esc, window: {}, STUDIO: undefined });
  if (studioPages) { c.STUDIO = { pages: studioPages }; c.window.STUDIO = c.STUDIO; }
  vm.runInContext(list.replace("const EMPTY_STARTERS", "globalThis.EMPTY_STARTERS") + fn("starterCardHTML")
    + "globalThis.card = starterCardHTML;", c);
  return c.EMPTY_STARTERS.map((s) => c.card(s));
}

test("the empty chat draws four starter cards, each with an icon, a title and a hint", () => {
  assert.match(fn("emptyChat"), /'<div class="ghost">' \+ EMPTY_STARTERS\.map\(starterCardHTML\)\.join\(''\)/);
  const cards = starters(null);
  assert.equal(cards.length, 4);
  for (const h of cards) {
    assert.match(h, /^<button class="ghostchip" /);
    assert.match(h, /<span class="gc-ic"><svg [^>]*stroke-width="1\.5"/);
    assert.match(h, /<span class="gc-t">[^<]+<\/span><span class="gc-d">[^<]+<\/span><\/button>$/);
  }
  // cards is an array from the vm context: Array.from makes it this realm's, or deepStrictEqual sees two prototypes.
  assert.deepEqual(Array.from(cards, (h) => h.match(/class="gc-t">([^<]+)</)[1]),
    ["Summarise this folder", "Create an image", "Make a video", "Write code"]);
});

test("a card fills the composer; Images and Video open Studio when its page is there", () => {
  const plain = starters(null);
  assert.ok(plain.every((h) => /data-fill="[^"]+"/.test(h) && !/data-act=/.test(h)), "no Studio: every card fills the composer");
  assert.match(plain[0], /data-fill="Summarise the files in this folder: /);
  const studio = starters({ images: {}, video: {} });
  assert.match(studio[1], /data-act="studio:open:images"/);
  assert.match(studio[2], /data-act="studio:open:video"/);
  assert.match(studio[0], /data-fill=/);
  assert.match(studio[3], /data-fill="Help me write code that "/);
  // The fill puts the caret at the end of the starter, ready to type on.
  assert.match(source, /if \(fill\) \{ S\.draft = fill\.dataset\.fill; render\(\); const en = \$\('#entry'\); if \(en\) \{ en\.focus\(\); en\.setSelectionRange\(en\.value\.length, en\.value\.length\);/);
});

test("Join Discord in the sidebar foot is a quiet 16px icon with only a hover wash", () => {
  const css = readFileSync(new URL("../renderer/css/shell.css", import.meta.url), "utf8");
  assert.match(css, /\.sb-discord\{flex:none;width:34px;height:34px;background:transparent;color:var\(--ink-2\)\}/);
  assert.match(css, /\.sb-discord:hover\{background:var\(--hover\);color:var\(--ink\)\}/);
  assert.match(css, /\.sb-discord svg\{width:16px;height:16px;stroke-width:1\.5\}/);
});
