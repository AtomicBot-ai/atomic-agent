// ATO-1211: on a cloud model the agent reports "no turn limit" as
// Number.MAX_SAFE_INTEGER, and the context popover printed
// "12 of 9007199254740991 turns kept". An unbounded cap is not shown.
//
// renderer.js is read as text; ctxBoundLine runs in a vm context with its
// neighbours stubbed. No deps, no build.
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

function boundLine(stored) {
  const c = vm.createContext({
    CTX055: { stored },
    esc: (s) => String(s),
    ic: () => "",
    fmtTokens: (n) => String(n),
  });
  vm.runInContext(fn("ctxKnownLimit") + fn("ctxBoundLine") + "globalThis.ctxBoundLine = ctxBoundLine;", c);
  return c.ctxBoundLine();
}

const pairs = (cap) => ({ conversationBoundBy: "pairs", conversationPairs: 12, conversationPairsCap: cap, droppedPairs: 0 });

test("a real turn cap keeps the 'N of X' sentence", () => {
  assert.match(boundLine(pairs(20)), /older turns are being dropped — 12 of 20 turns kept</);
});

test("an unbounded turn cap prints the bare count", () => {
  for (const cap of [Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, 1e12]) {
    const html = boundLine(pairs(cap));
    assert.match(html, /older turns are being dropped — 12 turns kept</, String(cap));
    assert.doesNotMatch(html, / of /);
    assert.doesNotMatch(html, /9007199254740991|Infinity/);
  }
});
