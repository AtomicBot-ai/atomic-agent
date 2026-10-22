// ATO-498: the Thinking budget knob reads in plain words, says it is one
// setting for Local models and Custom server, and says llama.cpp can hold
// no larger limit (agent MAX_REASONING_BUDGET_TOKENS, #600).
// ATO-795: only No limit and choices up to that cap (499) are offered, and a
// stored value above it shows as 499, the bound the model really gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  return renderer.slice(i, renderer.indexOf(end, i));
}

function knob() {
  const ctx = createContext({});
  runInContext(slice('const LLM_TUNE_BUDGET_MAX', 'function llmTuneRowHTML')
    + ';this.hint = llmTuneBudgetHint; this.shown = llmTuneBudgetShown; this.budgets = LLM_TUNE_BUDGETS;', ctx);
  return ctx;
}
function hint() { return knob().hint; }

test('each budget choice gets a plain-words tooltip', () => {
  const h = hint();
  assert.match(h(0), /No limit/);
  assert.equal(h(499), 'About 375 words of thinking');
  assert.equal(h(1500), 'About 1,125 words of thinking');
  assert.equal(h(8000), 'About 6,000 words of thinking');
});

test('the help line names both tabs and the llama.cpp limit, and keeps the title the smoke test pins', () => {
  const tune = slice('function llmTuneHTML()', 'async function llmTuneSet');
  assert.match(tune, /'Thinking budget'/);
  assert.match(tune, /One setting for Local models and Custom server/);
  assert.match(tune, /llama\.cpp cannot hold a larger limit/);
  assert.doesNotMatch(tune, /Default 1500/);
  assert.match(tune, /llmTuneBudgetHint\(n\)/);
});

test('offers No limit and choices up to the 499-token llama.cpp cap only', () => {
  const budgets = Array.from(knob().budgets);
  assert.equal(budgets[0], 0);
  assert.ok(budgets.includes(499));
  assert.ok(budgets.every((n) => n <= 499), String(budgets));
});

test('a stored budget shows the bound the model really gets: above the cap is 499, none is No limit', () => {
  const { shown } = knob();
  assert.equal(shown(undefined), 0);
  assert.equal(shown(null), 0);
  assert.equal(shown(0), 0);
  // Above the cap the grammar enforces 499, so the knob must not say No limit.
  assert.equal(shown(1500), 499);
  assert.equal(shown(500), 499);
  assert.equal(shown(8000), 499);
  assert.equal(shown(499), 499);
  assert.equal(shown(64), 64);
  assert.equal(shown(2.5), 0);
  assert.equal(shown(-5), 0);
  assert.equal(shown('1500'), 0);
});

test('the knob lights the shown value, never a raw stored one above the cap', () => {
  const tune = slice('function llmTuneHTML()', 'async function llmTuneSet');
  assert.match(tune, /llmTuneBudgetShown\(lm\.reasoningBudgetTokens\)/);
  assert.doesNotMatch(tune, /: 1500/);
  // A stored 1500 lights 499, which is already a choice, so no extra 1500 button appears.
  const { shown, budgets } = knob();
  assert.ok(Array.from(budgets).includes(shown(1500)));
});
