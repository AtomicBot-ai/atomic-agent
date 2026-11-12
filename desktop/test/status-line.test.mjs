import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../renderer/status-line.js');
const M = require('../out/main/app-memory.js');

// ATO-1186: the composer's quiet status line and the last reply's tok/s.

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a usage frame with the timed generation gives the reply speed', () => {
  const s = R.replySpeedOf({object: 'chat.completion.usage', usage: {completion_tokens: 60}, generation: {completion_tokens: 50, duration_ms: 2000}});
  assert.deepEqual(s, {tokens: 50, ms: 2000, tps: 25});
});

test('an older agent sends no generation: no speed, never a zero or a guess', () => {
  assert.equal(R.replySpeedOf({usage: {prompt_tokens: 10, completion_tokens: 60, total_tokens: 70}}), null);
  assert.equal(R.replySpeedOf(null), null);
  assert.equal(R.replySpeedOf(undefined), null);
  assert.equal(R.replySpeedOf({generation: {completion_tokens: 0, duration_ms: 900}}), null);
  assert.equal(R.replySpeedOf({generation: {completion_tokens: 40, duration_ms: 0}}), null);
  assert.equal(R.replySpeedOf({generation: {completion_tokens: 'x', duration_ms: 10}}), null);
  assert.equal(R.replySpeedHTML(null), '');
});

test('tok/s reads whole above 10 and with one decimal below', () => {
  assert.equal(R.tpsWord(42.4), '42 tok/s');
  assert.equal(R.tpsWord(7.46), '7.5 tok/s');
  assert.equal(R.tpsWord(3), '3 tok/s');
  assert.equal(R.tpsWord(0), '');
  assert.equal(R.tpsWord(NaN), '');
  const html = R.replySpeedHTML({tokens: 50, ms: 2000, tps: 25});
  assert.match(html, /class="msgtps"/);
  assert.match(html, />25 tok\/s</);
  assert.match(html, /50 tokens in 2\.0 s of generation/);
});

test('session time and memory words', () => {
  assert.equal(R.sessionTimeWord(30 * 1000), '<1m');
  assert.equal(R.sessionTimeWord(12 * 60 * 1000), '12m');
  assert.equal(R.sessionTimeWord(65 * 60 * 1000), '1h 05m');
  assert.equal(R.sessionTimeWord(-1), '');
  assert.equal(R.memWord(412 * 1024 * 1024), '412 MB');
  assert.equal(R.memWord(1.25 * 1024 ** 3), '1.3 GB');
  assert.equal(R.memWord(null), '');
  assert.equal(R.memWord(0), '');
});

test('the chat clock: a new chat that gets its id keeps counting, another chat starts again', () => {
  const st = {sid: null, since: 0};
  assert.equal(R.statusChatSince(st, null, 1000), 1000);
  assert.equal(R.statusChatSince(st, 'abc', 5000), 1000);   // the new chat was given its id
  assert.equal(R.statusChatSince(st, 'abc', 9000), 1000);
  assert.equal(R.statusChatSince(st, 'other', 10000), 10000); // opened another chat
  assert.equal(R.statusChatSince(st, null, 20000), 20000);    // a new chat
});

test('the line leaves out what it does not know and escapes the model name', () => {
  assert.equal(R.statusLineHTML({}), '');
  const html = R.statusLineHTML({model: 'Gemma <4>', tokens: 7500, tokensText: '7.5k', sessionMs: 12 * 60 * 1000, memBytes: 412 * 1024 * 1024});
  assert.match(html, /^<div class="cstatus"/);
  assert.match(html, /Gemma &lt;4&gt;/);
  assert.match(html, />7\.5k tokens</);
  assert.match(html, />12m</);
  assert.match(html, />412 MB</);
  assert.match(html, /Memory this app uses/);
  const bare = R.statusLineParts({model: 'm', tokens: 0, tokensText: '', sessionMs: 1000, memBytes: null}).map((p) => p.text);
  assert.deepEqual(bare, ['m', '<1m']);
});

test('the memory reading: read once while fresh, unknown on an older bridge, repaint on a new word', async () => {
  const S = R.STATUS_LINE;
  Object.assign(S, {memBytes: null, memAt: 0, pending: null});
  assert.equal(await R.statusMemRefresh({}, 1000), null);
  let calls = 0;
  let repaints = 0;
  S.onChange = () => { repaints++; };
  const br = {appMemory: async () => { calls++; return {bytes: 300 * 1024 * 1024}; }};
  assert.equal(await R.statusMemRefresh(br, 2000), 300 * 1024 * 1024);
  assert.equal(await R.statusMemRefresh(br, 2000 + R.STATUS_MEM_STALE_MS - 1), 300 * 1024 * 1024);
  assert.equal(calls, 1);
  assert.equal(repaints, 1);
  const failing = {appMemory: async () => { throw new Error('gone'); }};
  assert.equal(await R.statusMemRefresh(failing, 2000 + R.STATUS_MEM_STALE_MS + 1), 300 * 1024 * 1024);
  S.onChange = null;
});

test('main sums the app processes\' working sets, in bytes', () => {
  assert.equal(M.appMemoryBytes([{memory: {workingSetSize: 1000}}, {memory: {workingSetSize: 24}}, {memory: null}, {}]), 1024 * 1024);
  assert.equal(M.appMemoryBytes([]), null);
  assert.equal(M.appMemoryBytes(null), null);
  assert.equal(M.appMemoryBytes([{memory: {workingSetSize: NaN}}]), null);
});

test('wired: preload, main, the page and the renderer', () => {
  assert.match(src('../preload/preload.ts'), /appMemory: \(\) => ipcRenderer\.invoke\("app:memory"\)/);
  assert.match(src('../main/main.ts'), /ipcMain\.handle\("app:memory"/);
  const page = src('../renderer/index.html');
  assert.ok(page.indexOf('status-line.js') > 0 && page.indexOf('status-line.js') < page.indexOf('src="renderer.js"'), 'status-line.js loads before renderer.js');
  const r = src('../renderer/renderer.js');
  assert.match(r, /ev\.kind === 'usage'/);
  assert.match(r, /\+ composerStatusLine\(\)/);
  assert.match(r, /replySpeedHTML\(m\.speed\)/);
});
