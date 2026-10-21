// ATO-498: the Thinking budget knob reads in plain words, says it is one
// setting for Local models and Custom server, and admits the llama.cpp cap
// (at most 499 budget tokens, agent MAX_REASONING_BUDGET_TOKENS, #600).
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
  runInContext(slice('const LLM_TUNE_BUDGET_CAP', 'function llmTuneRowHTML') + ';this.hint = llmTuneBudgetHint;', ctx);
  return ctx.hint;
}

test('each budget choice gets a plain-words tooltip, and choices above the cap say they act like 500', () => {
  const h = hint();
  assert.match(h(0), /No limit/);
  assert.equal(h(500), 'About 375 words of thinking');
  for (const n of [1500, 4000, 8000]) assert.match(h(n), /acts like 500/, String(n));
  assert.doesNotMatch(h(500), /acts like/);
});

test('the help line names both tabs and the cap, and keeps the title the smoke test pins', () => {
  const tune = slice('function llmTuneHTML()', 'async function llmTuneSet');
  assert.match(tune, /'Thinking budget'/);
  assert.match(tune, /One setting for Local models and Custom server/);
  assert.match(tune, /llama\.cpp stops it at about 500/);
  assert.doesNotMatch(tune, /Default 1500/);
  assert.match(tune, /llmTuneBudgetHint\(n\)/);
});
