import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../renderer/llm-model-list.js');

// ATO-2413: Settings › Models, Cloud, OpenRouter stayed on "Fetching the model list…" for good.

/* Timers the test drives by hand. */
function fakeTimers() {
  const due = [];
  return {
    setTimeout: (fn, ms) => { const t = {fn, ms, live: true}; due.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    fire() { due.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }); },
  };
}

test('an answer in time is the answer', async () => {
  const t = fakeTimers();
  const res = await L.llmListAsk(() => Promise.resolve({ok: true, models: [{id: 'a'}]}), 'OpenRouter', 30000, t);
  assert.deepEqual(res, {ok: true, models: [{id: 'a'}]});
});

test('no answer by the deadline is an error that names the provider and the seconds, never an endless wait', async () => {
  const t = fakeTimers();
  const pending = L.llmListAsk(() => new Promise(() => {}), 'OpenRouter', 30000, t);
  t.fire();
  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.deadline, true);
  assert.equal(res.error, 'no answer from OpenRouter within 30 s');
  assert.ok(res.late && typeof res.late.then === 'function');
});

test('an answer that lands after the deadline is still handed over through `late`', async () => {
  const t = fakeTimers();
  let answer;
  const pending = L.llmListAsk(() => new Promise((r) => { answer = r; }), 'OpenRouter', 30000, t);
  t.fire();
  const res = await pending;
  answer({ok: true, models: [{id: 'late'}]});
  assert.deepEqual(await res.late, {ok: true, models: [{id: 'late'}]});
});

test('a bridge that throws or rejects reads as an error, so the busy flag can clear', async () => {
  const t = fakeTimers();
  const rejected = await L.llmListAsk(() => Promise.reject(new Error('ipc gone')), 'OpenRouter', 30000, t);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /ipc gone/);
  const thrown = await L.llmListAsk(() => { throw new Error('no bridge'); }, 'OpenRouter', 30000, t);
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /no bridge/);
  const empty = await L.llmListAsk(() => Promise.resolve(null), 'OpenRouter', 30000, t);
  assert.equal(empty.ok, false);
});

test('with no timers passed it calls the global timers bare, as the window needs', async () => {
  // Chromium's timers throw "Illegal invocation" when called on another object; these do the same.
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const wrongThis = [];
  function strictSet(fn, ms) { 'use strict'; if (this !== undefined && this !== globalThis) { wrongThis.push('setTimeout'); throw new TypeError('Illegal invocation'); } return realSet(fn, ms); }
  function strictClear(id) { 'use strict'; if (this !== undefined && this !== globalThis) { wrongThis.push('clearTimeout'); throw new TypeError('Illegal invocation'); } return realClear(id); }
  globalThis.setTimeout = strictSet;
  globalThis.clearTimeout = strictClear;
  try {
    const res = await L.llmListAsk(() => Promise.resolve({ok: true, models: [{id: 'a'}]}), 'OpenRouter', 30000);
    assert.deepEqual(res, {ok: true, models: [{id: 'a'}]});
    assert.deepEqual(wrongThis, []);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('the deadline defaults to 30 s', () => {
  assert.equal(L.LLM_LIST_DEADLINE_MS, 30000);
  assert.equal(L.llmListDeadlineLine('AI/ML API'), 'no answer from AI/ML API within 30 s');
});

test('the last good list is kept per provider and handed back as a copy', () => {
  L.LLM_LIST_CACHE.clear();
  assert.equal(L.llmListCacheGet('openrouter'), null);
  L.llmListCachePut('openrouter', [{id: 'x'}, {id: 'y'}]);
  L.llmListCachePut('aimlapi', []);   // an empty list is not a good one
  const hit = L.llmListCacheGet('openrouter');
  assert.deepEqual(hit, [{id: 'x'}, {id: 'y'}]);
  hit.push({id: 'z'});
  assert.equal(L.llmListCacheGet('openrouter').length, 2);
  assert.equal(L.llmListCacheGet('aimlapi'), null);
});

test('a section with nothing asking schedules one ask, after the paint, not one per paint', () => {
  L.LLM_LIST_KICK.pending = false;
  const queued = [];
  let runs = 0;
  const defer = (fn) => queued.push(fn);
  assert.equal(L.llmListScheduleAsk(() => { runs++; }, defer), true);
  assert.equal(L.llmListScheduleAsk(() => { runs++; }, defer), false);
  assert.equal(runs, 0);
  queued.shift()();
  assert.equal(runs, 1);
  assert.equal(L.llmListScheduleAsk(() => { runs++; }, defer), true);
});

test('renderer.js wires it: the ask has the deadline, a section with no ask starts one, the error has Try again', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="llm-model-list.js"') !== -1 && html.indexOf('src="llm-model-list.js"') < html.indexOf('src="renderer.js"'));
  const fetchFn = src.slice(src.indexOf('async function llmFetchModels('), src.indexOf('function llmTakeModels('));
  assert.match(fetchFn, /llmListAsk\(\(\) => BR\.providerModels\(/);
  assert.doesNotMatch(fetchFn, /await BR\.providerModels\(/);
  // A rejected ask turns into an error result, so the code below it clears modelsBusy.
  assert.match(fetchFn, /providerWord\(p\.id\)\)\s*\.catch\(/);
  const section = src.slice(src.indexOf('function llmCloudSection(tab)'), src.indexOf('function llmCloudSectionStart('));
  assert.match(section, /llmListScheduleAsk\(llmEnsureModels\)/);
  const ensure = src.slice(src.indexOf('async function llmEnsureModels('), src.indexOf('async function llmFetchModels('));
  assert.match(ensure, /llmListCacheGet\(p\.id\)/);
  const list = src.slice(src.indexOf('function llmCloudModelListHTML('), src.indexOf('function llmCloudModelListHTML(') + 3000);
  const errLine = list.slice(list.indexOf("section.status === 'error'"));
  assert.match(errLine.slice(0, 600), /data-act="llm:modelsRetry"/);
});
