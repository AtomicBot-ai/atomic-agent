// ATO-1729: a chat whose replies attached the same picture twice, with the
// file gone, threw "Cannot read properties of undefined (reading 'state')" on
// open: the first pass dropped the failed entry and the second read it.
//
// renderer.js is read as text; revalidateChatImages runs in a vm context
// with its neighbours stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function asyncFn(name) {
  const at = source.indexOf("\nasync function " + name + "(");
  assert.ok(at >= 0, name + " is a top-level async function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function load({ entries, files }) {
  const calls = { changed: 0, stat: [] };
  const c = vm.createContext({
    CHAT_IMG: new Map(entries),
    ATTACH_STAT_CHUNK: 64,
    BR: { statPaths: (paths) => { calls.stat.push(paths); return { ok: true, files }; } },
    chatImagesChanged: () => { calls.changed++; },
  });
  vm.runInContext(asyncFn("revalidateChatImages") + "globalThis.revalidateChatImages = revalidateChatImages;", c);
  return { c, calls };
}

test("a missing picture named by two replies is dropped once, without throwing", async () => {
  const { c, calls } = load({ entries: [["/tmp/a.png", { state: "fail" }]], files: [] });
  await c.revalidateChatImages(["/tmp/a.png", "/tmp/a.png"]);
  assert.equal(c.CHAT_IMG.has("/tmp/a.png"), false);
  assert.equal(calls.changed, 1);
});

test("a held picture named twice is stat'ed once", async () => {
  const st = { state: "ok", size: 10, mtimeMs: 5 };
  const { c, calls } = load({
    entries: [["/tmp/b.png", st]],
    files: [{ path: "/tmp/b.png", exists: false }],
  });
  await c.revalidateChatImages(["/tmp/b.png", "/tmp/b.png"]);
  assert.equal(calls.stat.length, 1);
  assert.deepEqual([...calls.stat[0]], ["/tmp/b.png"]);
  assert.equal(c.CHAT_IMG.has("/tmp/b.png"), false);
  assert.equal(calls.changed, 1);
});
