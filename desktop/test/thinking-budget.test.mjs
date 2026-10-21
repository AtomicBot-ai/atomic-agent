// ATO-498: the Thinking budget knob reads in plain words, says it is one
// setting for Local models and Custom server, and says llama.cpp can stop it
// sooner than the number picked (agent MAX_REASONING_BUDGET_TOKENS, #600).
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

function hint() {
  const ctx = createContext({});
  runInContext(slice('function llmTuneBudgetHint', 'function llmTuneRowHTML') + ';this.hint = llmTuneBudgetHint;', ctx);
  return ctx.hint;
}

test('each budget choice gets a plain-words tooltip', () => {
  const h = hint();
  assert.match(h(0), /No limit/);
  assert.equal(h(500), 'About 375 words of thinking');
  assert.equal(h(1500), 'About 1,125 words of thinking');
  assert.equal(h(8000), 'About 6,000 words of thinking');
});

test('the help line names both tabs and the llama.cpp limit, and keeps the title the smoke test pins', () => {
  const tune = slice('function llmTuneHTML()', 'async function llmTuneSet');
  assert.match(tune, /'Thinking budget'/);
  assert.match(tune, /One setting for Local models and Custom server/);
  assert.match(tune, /llama\.cpp can stop it sooner than the number you pick/);
  assert.doesNotMatch(tune, /Default 1500/);
  assert.match(tune, /llmTuneBudgetHint\(n\)/);
});
