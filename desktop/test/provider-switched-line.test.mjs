// ATO-483: a fallback that answered is one line in the transcript, never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('function providerSwitchedLine(p)');
const end = renderer.indexOf('\n}\n', start) + 3;
const ctx = createContext({});
runInContext(renderer.slice(start, end) + ';this.line = providerSwitchedLine;', ctx);

test("the agent's own sentence is shown as it is", () => {
  assert.equal(ctx.line({ notice: 'OpenRouter is rate-limited, switched to Gemini (gemini-2.5-flash).', from: 'openrouter', to: 'gemini' }),
    'OpenRouter is rate-limited, switched to Gemini (gemini-2.5-flash).');
});

test('without a notice the ids still say who answered; nothing to say gives an empty line', () => {
  assert.equal(ctx.line({ from: 'openrouter', to: 'gemini', to_model: 'gemini-2.5-flash' }), 'openrouter failed, switched to gemini (gemini-2.5-flash).');
  assert.equal(ctx.line({}), '');
  assert.equal(ctx.line(null), '');
});

test('the frame draws into the turn and is handled by the chat event router', () => {
  assert.match(renderer, /'provider_recovered', 'provider_switched',/);
  assert.match(renderer, /if \(ev\.kind === 'provider_switched'\) \{/);
});

// ATO-1459: the line carries a button: Fallback settings, or Check key when the provider refused the key.
const actAt = renderer.indexOf('function providerSwitchedAct(p)');
runInContext(renderer.slice(actAt, renderer.indexOf('\n}\n', actAt) + 3) + ';this.act = providerSwitchedAct;', ctx);

test('a fallback that answered offers Fallback settings; a refused key offers Check key on the provider switched away from', () => {
  assert.equal(ctx.act({ from: 'openrouter', to: 'gemini', cause: 'rate_limited' }).act, 'fallback-settings');
  assert.equal(ctx.act({ from: 'openrouter', to: 'gemini' }).act, 'fallback-settings');
  const key = ctx.act({ from: 'openrouter', to: 'gemini', cause: 'auth_rejected' });
  assert.equal(key.act, 'fix-key');
  assert.equal(key.keyFor, 'openrouter');
  assert.match(renderer, /note:true, text: esc\(line\), \.\.\.providerSwitchedAct\(p\)\}/);
});
