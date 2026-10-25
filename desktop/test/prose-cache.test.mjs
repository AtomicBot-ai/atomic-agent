// ATO-1023: a finished message's markup is made once (renderProse's cache),
// and a chat render morphs #content instead of replacing it.
//
// renderer.js is read as text; renderProse runs in a vm context with
// renderProseFresh stubbed. No deps, no build.
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
function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function harness() {
  const c = vm.createContext({ calls: [], REPLY_PATH_RETRY_MS: 15000, Date });
  vm.runInContext(
    constLine("PROSE_CACHE") + fn("renderProse")
      + "function renderProseFresh(t) { calls.push(t); return t.includes('PENDING') ? '<span data-rpath=\"x\">' + t + '</span>' : '<p>' + t + '</p>'; }"
      + "globalThis.renderProse = renderProse; globalThis.cache = PROSE_CACHE;",
    c);
  return c;
}

test("the same text is rendered once", () => {
  const c = harness();
  assert.equal(c.renderProse("hello"), "<p>hello</p>");
  assert.equal(c.renderProse("hello"), "<p>hello</p>");
  assert.deepEqual([...c.calls], ["hello"]);
});

test("a path answer from main invalidates every entry", () => {
  const c = harness();
  c.renderProse("see ~/a.md");
  c.cache.ver++;
  c.renderProse("see ~/a.md");
  assert.equal(c.calls.length, 2);
});

test("markup still waiting on main is not kept", () => {
  const c = harness();
  c.renderProse("PENDING ~/a.md");
  c.renderProse("PENDING ~/a.md");
  assert.equal(c.calls.length, 2);
});

test("a growing stream keeps one entry, not one per frame", () => {
  const c = harness();
  c.renderProse("old message");
  for (const t of ["H", "He", "Hel", "Hell", "Hello"]) c.renderProse(t);
  assert.deepEqual([...c.cache.map.keys()], ["old message", "Hello"]);
});

test("the cache is bounded", () => {
  const c = harness();
  c.cache.max = 3;
  for (const t of ["a1", "b2", "c3", "d4"]) c.renderProse(t);
  assert.equal(c.cache.map.size, 3);
  assert.ok(!c.cache.map.has("a1"));
});

test("a chat render morphs #content and wires the scroller once", () => {
  const body = fn("renderContent");
  assert.match(body, /morphChildren\(c, next\.content\)/);
  assert.doesNotMatch(body, /c\.innerHTML = chatView\(\)/);
  const after = fn("afterChat");
  assert.match(after, /SCROLL_WIRED\.has\(sc\)/);
});
