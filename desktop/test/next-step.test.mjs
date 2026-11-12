// Unit tests for ATO-1094 / ATO-1096: the grey next-step suggestion in the
// composer (renderer/next-step.js, pure half), its two analytics events and
// the hooks renderer.js calls.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("../renderer/next-step.js");
const V = require("../out/main/analytics/validate.js");

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the suggestion is one trimmed line, capped, and empty text is none", () => {
  assert.equal(N.nextStepClean("  Run the tests\n  again  "), "Run the tests again");
  assert.equal(N.nextStepClean(""), null);
  assert.equal(N.nextStepClean("   \n "), null);
  assert.equal(N.nextStepClean(null), null);
  assert.equal(N.nextStepClean(42), null);
  const long = N.nextStepClean("x".repeat(500));
  assert.equal(long.length, N.NEXT_STEP_MAX_CHARS);
  assert.ok(long.endsWith("…"));
});

const base = { key: "Tab", shift: false, alt: false, meta: false, ctrl: false, composing: false, draft: "", ghost: true };

test("a bare Tab takes the suggestion and Escape puts it away", () => {
  assert.equal(N.nextStepKeyAction(base), "accept");
  assert.equal(N.nextStepKeyAction({ ...base, key: "Escape" }), "dismiss");
});

test("other keys, and Tab with no suggestion, keep their usual meaning", () => {
  assert.equal(N.nextStepKeyAction({ ...base, ghost: false }), null);
  assert.equal(N.nextStepKeyAction({ ...base, key: "Enter" }), null);   // never sends it
  assert.equal(N.nextStepKeyAction({ ...base, key: "a" }), null);
  assert.equal(N.nextStepKeyAction({ ...base, shift: true }), null);     // Shift+Tab still moves focus back
  assert.equal(N.nextStepKeyAction({ ...base, ctrl: true }), null);
  assert.equal(N.nextStepKeyAction({ ...base, meta: true }), null);
  assert.equal(N.nextStepKeyAction({ ...base, alt: true }), null);
  assert.equal(N.nextStepKeyAction({ ...base, composing: true }), null); // an IME owns its keys
  assert.equal(N.nextStepKeyAction({ ...base, draft: "/mo" }), null);    // typed text: the slash list keeps Tab
  assert.equal(N.nextStepKeyAction(null), null);
});

test("suggestion_shown has no properties and suggestion_accepted only a duration: never the text", () => {
  const shown = V.validateEvent("suggestion_shown", { text: "Run the tests", suggestion: "Run the tests" }, "ui");
  assert.ok(shown);
  assert.deepEqual(shown.props, {});
  const ok = V.validateEvent("suggestion_accepted", { ms_to_accept: 2300, text: "Run the tests" }, "ui");
  assert.deepEqual(ok.props, { ms_to_accept: 2300 });
  assert.deepEqual(V.validateEvent("suggestion_accepted", { ms_to_accept: null }, "ui").props, { ms_to_accept: null });
});

test("the composer calls the module where the issue says (renderer.js, index.html)", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /if \(nextStepKey\(e\)\) return;[^\n]*\n\s*if \(k === 'Enter' && !e\.shiftKey && !e\.altKey && e\.target\.id === 'entry'\)/);
  assert.match(r, /nextStepTyped\(e\.target\);/);
  assert.match(r, /autosize\(e\);\n\s*nextStepPaint\(e\);/);
  assert.match(r, /nextStepTurnEnded\(sid, ev\.kind\);/);
  assert.match(r, /\+ nextStepRowHTML\(\)/);
  assert.match(r, /a === 'nextstep:toggle'/);
  // The slash list's Tab is handled above the suggestion's.
  assert.ok(r.indexOf("acceptSlash(m[S.slashCur][0])") < r.indexOf("if (nextStepKey(e)) return;"));
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="next-step.js"') > 0);
  assert.ok(html.indexOf('src="next-step.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.indexOf('src="config-patch.js"') < html.indexOf('src="next-step.js"'));
});

test("the toggle writes tui.nextStepSuggestions and is off unless it is true", () => {
  const m = src("../renderer/next-step.js");
  assert.match(m, /configPatchOr\(\{tui:\{nextStepSuggestions:!!enabled\}\}/);
  assert.match(m, /BR\.configSet\('tui\.nextStepSuggestions'/);
  assert.match(m, /t\.nextStepSuggestions === true/);
});
