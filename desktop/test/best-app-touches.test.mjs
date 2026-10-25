// ATO-1032: the cheap habits of the best desktop apps — one suggestion on
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

test("the row carries the age only where nothing is queued", () => {
  const row = fn("chatRow");
  assert.match(row, /const age = queued \? '' : chatAgeShort\(s\.updatedAt\);/);
  assert.match(row, /data-m="' \+ queued \+ ' queued" data-queued=/);
});

test("one suggestion, the platform's Stop chord, New chat's chord on the row", () => {
  assert.match(fn("emptyChat"), /\['Summarise the files in this folder'\]/);
  assert.doesNotMatch(source, /title="Stop \(Ctrl\+\.\)"/);
  assert.match(source, /kbdText\('Stop \(⌘ \.\)'\)/);
  assert.match(source, /class="sb-new" data-act="session:new" data-kbd=/);
});
