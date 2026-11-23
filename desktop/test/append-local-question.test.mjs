// ATO-1461: the desktop's "Local model is set as your last-resort fallback.
// Keep it?" card (renderer/append-local-question.js) and its wiring.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {createAppendLocalQuestion} = require('../renderer/append-local-question.js');

const Q = 'Local model is set as your last-resort fallback. Keep it?';
const asking = {question: Q, detail: 'When your cloud model fails, the agent switches the chat to your local model.', appendLocal: true, answer: null};
const answered = (answer) => ({question: null, detail: null, appendLocal: answer === 'keep', answer});

function fakeApi(reads, answers = []) {
  const posted = [];
  return {posted, read: async () => reads.shift(), answer: async (a) => { posted.push(a); return answers.shift(); }};
}

test('asks when the agent has the question, and Turn off closes it', async () => {
  const api = fakeApi([{supported: true, ok: true, status: asking}], [{ok: true, status: answered('off')}]);
  const alq = createAppendLocalQuestion(api);
  assert.equal((await alq.check()).question, Q);
  const res = await alq.answer('off');
  assert.equal(res.ok, true);
  assert.deepEqual(api.posted, ['off']);
  assert.equal(alq.state.question, null);
});

test('nothing to ask, or an agent without the route, shows nothing', async () => {
  const none = createAppendLocalQuestion(fakeApi([{supported: true, ok: true, status: answered('keep')}]));
  assert.equal(await none.check(), null);
  const old = createAppendLocalQuestion(fakeApi([{supported: false}]));
  assert.equal(await old.check(), null);
  assert.equal(old.state.supported, false);
  assert.deepEqual(await old.answer('keep'), {ok: false, unsupported: true});
});

test('Not now closes it without an answer; a failed save keeps it with the error', async () => {
  const later = createAppendLocalQuestion(fakeApi([{supported: true, ok: true, status: asking}]));
  await later.check();
  later.dismiss();
  assert.equal(later.state.question, null);

  const api = fakeApi([{supported: true, ok: true, status: asking}], [{ok: false, error: 'disk full'}]);
  const failing = createAppendLocalQuestion(api);
  await failing.check();
  await failing.answer('keep');
  assert.equal(failing.state.question.question, Q);
  assert.equal(failing.state.error, 'disk full');
  assert.deepEqual(await failing.answer('maybe'), {ok: false});
});

test('the renderer shows the card, routes its buttons and Escape, and counts a manual turn-on as Keep', () => {
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../main/agent-client.ts', import.meta.url), 'utf8');
  assert.match(html, /<script src="append-local-question\.js"><\/script>/);
  assert.match(preload, /appendLocalQuestion: \(\) => ipcRenderer\.invoke\("agent:appendLocalQuestion"\)/);
  assert.match(client, /\/api\/fallback\/local-question/);
  assert.match(renderer, /else if \(alqOnScreen\(\)\) html \+= appendLocalQuestionHTML\(\);/);
  assert.match(renderer, /data-act="alq:off"/);
  assert.match(renderer, /data-act="alq:keep"/);
  assert.match(renderer, /if \(k === 'alq'\) \{ appendLocalQuestionAct\(v \|\| ''\); return; \}/);
  assert.match(renderer, /if \(alqOnScreen\(\)\) \{ act\('alq:later'\); return; \}/);
  assert.match(renderer, /appendLocalQuestionCheck\(\);   \/\/ ATO-1461/);
  assert.match(renderer, /if \(appendLocal && \(llm\.fallback \|\| \{\}\)\.appendLocal !== true\) ALQ\.answer\('keep'\);/);
});
