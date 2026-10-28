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
  assert.equal(ctx.line({ notice: 'OpenRouter is rate-limited, answered with Gemini (gemini-2.5-flash).', from: 'openrouter', to: 'gemini' }),
    'OpenRouter is rate-limited, answered with Gemini (gemini-2.5-flash).');
});

test('without a notice the ids still say who answered; nothing to say gives an empty line', () => {
  assert.equal(ctx.line({ from: 'openrouter', to: 'gemini', to_model: 'gemini-2.5-flash' }), 'openrouter failed, answered with gemini (gemini-2.5-flash).');
  assert.equal(ctx.line({}), '');
  assert.equal(ctx.line(null), '');
});

test('the frame draws into the turn and is handled by the chat event router', () => {
  assert.match(renderer, /'provider_recovered', 'provider_switched',/);
  assert.match(renderer, /if \(ev\.kind === 'provider_switched'\) \{/);
});
