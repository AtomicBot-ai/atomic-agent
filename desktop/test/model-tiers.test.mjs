// ATO-32: the model step shows the agent's Cheap / Balanced / Best picks first.
// renderer.js is read as text and the pieces run in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('let MODEL_TIERS = null;');
const end = renderer.indexOf('function wizModelStepHTML(withFoot)');
assert.ok(start > 0 && end > start);

const TIERS = { openrouter: [
  { tier: 'cheap', label: 'Cheap', model: 'deepseek/deepseek-v4-flash' },
  { tier: 'balanced', label: 'Balanced', model: 'google/gemini-3.7-flash' },
  { tier: 'best', label: 'Best', model: 'anthropic/claude-sonnet-5' },
], 'claude-cli': [{ tier: 'cheap', label: 'Cheap', model: 'haiku' }] };

function load(answer) {
  let asked = 0;
  const ctx = createContext({ render() {}, BR: { modelTiers: () => { asked++; return Promise.resolve(answer); } } });
  runInContext(renderer.slice(start, end) + ';this.withModelTiers = withModelTiers; this.modelTierKey = modelTierKey;', ctx);
  return { ctx, asked: () => asked };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const plain = (x) => JSON.parse(JSON.stringify(x));
const MODELS = ['a/x', 'anthropic/claude-sonnet-5', 'b/y', 'deepseek/deepseek-v4-flash', 'google/gemini-3.7-flash'].map((id) => ({ id }));

test('tiered models lead, labelled, in Cheap / Balanced / Best order; the rest keep their order', async () => {
  const { ctx, asked } = load({ ok: true, data: { tiers: TIERS } });
  assert.deepEqual(plain(ctx.withModelTiers(MODELS, 'openrouter')), plain(MODELS), 'nothing until the agent answers');
  await tick();
  const out = plain(ctx.withModelTiers(MODELS, 'openrouter'));
  assert.deepEqual(out.map((m) => m.id), ['deepseek/deepseek-v4-flash', 'google/gemini-3.7-flash', 'anthropic/claude-sonnet-5', 'a/x', 'b/y']);
  assert.deepEqual(out.slice(0, 3).map((m) => m.tier), ['Cheap', 'Balanced', 'Best']);
  assert.equal(out[3].tier, undefined);
  assert.equal(asked(), 1, 'asked once');
});

test('a core without the route leaves the list alone', async () => {
  const { ctx } = load({ ok: false, error: '/api/model-tiers → HTTP 404' });
  ctx.withModelTiers(MODELS, 'openrouter'); await tick();
  assert.deepEqual(plain(ctx.withModelTiers(MODELS, 'openrouter')), plain(MODELS));
});

test('a subscription row is keyed by its CLI', () => {
  const { ctx } = load({ ok: true, data: { tiers: TIERS } });
  assert.equal(ctx.modelTierKey({ kind: 'subscription-cli', subscriptionCli: 'claude' }), 'claude-cli');
  assert.equal(ctx.modelTierKey({ kind: 'subscription-cli', subscriptionCli: { cli: 'codex' } }), 'codex-cli');
  assert.equal(ctx.modelTierKey({ kind: 'openrouter' }), 'openrouter');
});
