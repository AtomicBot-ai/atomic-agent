// ATO-2495: the context popover's "reserved for reply" row draws the agent's
// own reserve when it sends one, and otherwise follows the agent's rule,
// small windows included (ATO-296), instead of half the window alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const {
  REPLY_RESERVE_MAX_WINDOW_SHARE, ctxPortedReplyReserve, ctxAgentReplyReserve, ctxReplyReserve,
} = createRequire(import.meta.url)('../renderer/ctx-reply-reserve.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const renderer = read('../renderer/renderer.js');
const html = read('../renderer/index.html');
const budget = read('../../src/prompt/token-budget.ts');
const port = read('../renderer/ctx-reply-reserve.js');

test('the port gives the agent figures on small windows (8k 2048, 16k 4096, 24k 8192, 32k half)', () => {
  assert.equal(ctxPortedReplyReserve(16384, 8192), 2048);
  assert.equal(ctxPortedReplyReserve(16384, 16384), 4096);
  assert.equal(ctxPortedReplyReserve(16384, 24576), 8192);
  assert.equal(ctxPortedReplyReserve(96000, 32768), 16384);
  assert.equal(ctxPortedReplyReserve(4096, 131072), 4096);
  assert.equal(ctxPortedReplyReserve(0, 32768), 0);
});

test('the port is pinned to the constants of src/prompt/token-budget.ts', () => {
  const num = (src, name) => {
    const m = src.match(new RegExp(name + '\\s*=\\s*([\\d_.]+)'));
    assert.ok(m, name + ' not found');
    return Number(m[1].replace(/_/g, ''));
  };
  assert.equal(REPLY_RESERVE_MAX_WINDOW_SHARE, num(budget, 'export const REPLY_RESERVE_MAX_WINDOW_SHARE'));
  assert.equal(num(port, 'const CTX_SMALL_WINDOW_PROMPT_ROOM'), num(budget, 'export const SMALL_WINDOW_PROMPT_ROOM'));
  assert.equal(num(port, 'const CTX_SMALL_WINDOW_REPLY_SHARE'), num(budget, 'export const SMALL_WINDOW_REPLY_SHARE'));
  assert.equal(num(port, 'const CTX_MIN_SMALL_WINDOW_REPLY_RESERVE'), num(budget, 'export const MIN_SMALL_WINDOW_REPLY_RESERVE'));
});

test("the agent's reserve wins, and never more than the prompt left", () => {
  assert.equal(ctxReplyReserve(16384, 32768, 9000, 5000), 5000);
  assert.equal(ctxReplyReserve(16384, 16384, 9000, null), 4096);
  assert.equal(ctxReplyReserve(16384, 16384, 15000, 4096), 1384);
  assert.equal(ctxReplyReserve(16384, null, 9000, 4096), 0);
});

test('which figure counts as the agent reserve', () => {
  assert.equal(ctxAgentReplyReserve({ source: 'measured', agentReserve: 4096 }), 4096);
  // A preview that sends replyCap already held its reservedForReply.
  assert.equal(ctxAgentReplyReserve({ source: 'built', reserved: 8192, replyCap: 16384, agentReserve: null }), 8192);
  // An older agent sent the raw cap as reservedForReply: a cap, not a reserve.
  assert.equal(ctxAgentReplyReserve({ source: 'built', reserved: 96000, replyCap: 0, agentReserve: null }), null);
  assert.equal(ctxAgentReplyReserve({ source: 'projected', reserved: 0, replyCap: 0 }), null);
});

test('the renderer uses the module, reads usage.replyReserve and never keeps a stale one', () => {
  assert.ok(html.indexOf('ctx-reply-reserve.js') > 0 && html.indexOf('ctx-reply-reserve.js') < html.indexOf('src="renderer.js"'));
  assert.ok(!/function ctxReplyReserve\(/.test(renderer), 'renderer.js must not define its own copy');
  assert.ok(!/const REPLY_RESERVE_MAX_WINDOW_SHARE/.test(renderer));
  assert.ok(renderer.includes('ctxReplyReserve(replyCap, win, CTX.tokens, ctxAgentReplyReserve(CTX))'));
  assert.equal((renderer.match(/agentReserve: typeof (u|r\.usage)\.replyReserve === 'number'/g) || []).length, 2);
  assert.ok(renderer.includes('Object.assign(CTX, {agentReserve:null}, usage)'));
});
