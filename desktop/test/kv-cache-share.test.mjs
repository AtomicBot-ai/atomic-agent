import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const K = require('../renderer/kv-cache-share.js');

// ATO-631: the KV-cache share beside the last reply's tok/s.

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a step_speed frame gives the prompt and the cached part', () => {
  const frame = {object: 'atomic.step_speed', session_id: 's', step_index: 2, prompt_tokens: 1000, cached_tokens: 920, prefill_ms: 300, decode_ms: 4000, decode_tokens_per_second: 12.5};
  assert.deepEqual(K.stepCacheOf(frame), {prompt: 1000, cached: 920});
  assert.equal(K.cacheShareWord(K.stepCacheOf(frame)), 'cache 92%');
});

test('no prompt size, no reading; a cached count over the prompt is clamped', () => {
  assert.equal(K.stepCacheOf(null), null);
  assert.equal(K.stepCacheOf({}), null);
  assert.equal(K.stepCacheOf({prompt_tokens: 0, cached_tokens: 0}), null);
  assert.equal(K.stepCacheOf({prompt_tokens: 'x'}), null);
  assert.deepEqual(K.stepCacheOf({prompt_tokens: 50, cached_tokens: 80}), {prompt: 50, cached: 50});
  assert.deepEqual(K.stepCacheOf({prompt_tokens: 50}), {prompt: 50, cached: 0});
  assert.equal(K.cacheShareWord(null), '');
  assert.equal(K.cacheShareHTML(null), '');
});

test('a partial hit never reads as all or none', () => {
  assert.equal(K.cacheShareWord({prompt: 1000, cached: 999}), 'cache 99%');
  assert.equal(K.cacheShareWord({prompt: 1000, cached: 1000}), 'cache 100%');
  assert.equal(K.cacheShareWord({prompt: 1000, cached: 2}), 'cache 1%');
  assert.equal(K.cacheShareWord({prompt: 1000, cached: 0}), 'cache 0%');
});

test('the HTML is a quiet figure with the exact counts in its tooltip', () => {
  const html = K.cacheShareHTML({prompt: 30000, cached: 27600});
  assert.match(html, /class="msgtps msgcache"/);
  assert.match(html, />cache 92%</);
  assert.match(html, /27600 of 30000 prompt tokens/);
});

test('wired: loaded before renderer.js, the frame kept on the reply, shown beside tok/s', () => {
  const html = src('../renderer/index.html');
  const own = html.indexOf('<script src="kv-cache-share.js"');
  assert.ok(own > 0 && own < html.indexOf('<script src="renderer.js"'));
  const r = src('../renderer/renderer.js');
  assert.match(r, /ev\.kind === 'step_speed'/);
  assert.match(r, /stepCacheOf\(ev\.payload\)/);
  assert.match(r, /cacheShareHTML\(m\.kvCache\)/);
});
