// ATO-1281: the Add provider wizard threw "TypeError: Cannot read properties
// of null (reading 'custom')" in wizardHTML. A step awaiting the network
// (wizNext -> wizNextStep) outlived its wizard: Cancel cleared the phase, the
// wizard was opened again (row = null, phase = pick_kind), and when the
// await returned the step set phase = pick_model and redrew with no row.
//
// renderer.js is read as text; the pieces run in a vm. No deps, no build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');

function fn(name, prefix = 'function ') {
  const at = source.indexOf('\n' + prefix + name + '(');
  assert.ok(at >= 0, name + ' is a top-level function in renderer.js');
  return source.slice(at + 1, source.indexOf('\n}\n', at) + 2);
}

const ROW = { id: 'claude-code', label: 'Claude Code', kind: 'claude-code', subscriptionCli: 'claude', defaultModel: 'sonnet' };

function load(WIZ, providerModels) {
  const removed = [];
  const drawn = [];
  const ctx = createContext({
    WIZ,
    KIND_ROWS: [ROW, { id: 'custom', label: 'Custom', kind: 'openai-compatible', custom: true }],
    OB: { open: false },
    ANX: { providerFailed() {} },
    esc: (s) => String(s),
    providerMark: () => '',
    selProviders: () => [],
    selShell: (title, body, foot) => title + '|' + body + '|' + foot,
    wizService: (k) => k.label,
    wizSubReady: () => true,
    wizSubscriptionEntry: (k) => ({ id: k.id, kind: k.kind }),
    wizActivate: () => {},
    wizRemoveIfIncomplete: (id) => { removed.push(id); },
    BR: { upsertProvider: () => Promise.resolve({ ok: true }), providerModels },
  });
  // Only a wizard with no row is drawn here: the list, or the screen that threw.
  ctx.render = () => { if (!WIZ.row) drawn.push(ctx.wizardHTML()); };
  runInContext(fn('wizardHTML') + fn('wizStepLeft') + fn('wizSubscriptionStep', 'async function '), ctx);
  return { ctx, removed, drawn };
}

test('a step past the list with no row draws the list, it does not throw', () => {
  for (const phase of ['configure', 'verifying', 'pick_model']) {
    const { ctx } = load({ phase, row: null });
    let html;
    assert.doesNotThrow(() => { html = ctx.wizardHTML(); }, phase);
    assert.match(html, /^Add a provider\|/, phase);
    assert.match(html, /data-wiz-kind="0"/, phase);
  }
});

test('a step whose wizard was left and opened again does not take it over', async () => {
  let answer;
  const WIZ = { phase: 'configure', row: ROW, modelChosen: false };
  const { ctx, drawn } = load(WIZ, () => new Promise((r) => { answer = r; }));
  const step = ctx.wizSubscriptionStep(ROW);
  await new Promise((r) => setImmediate(r));
  assert.equal(WIZ.phase, 'verifying');
  assert.ok(answer, 'the step is awaiting the model list');
  // Cancel, then Add provider again (act 'wiz:cancel', then 'sel:add').
  WIZ.phase = null;
  WIZ.phase = 'pick_kind'; WIZ.row = null;
  answer({ ok: true, models: [{ id: 'sonnet' }] });
  await step;
  assert.equal(WIZ.phase, 'pick_kind', 'the reopened wizard keeps its list');
  assert.ok(drawn.every((h) => typeof h === 'string'));
});

test('a step whose wizard was closed leaves it closed and drops its unfinished entry', async () => {
  let answer;
  const WIZ = { phase: 'configure', row: ROW, modelChosen: false, unfinishedId: 'claude-code', dropAfterStep: false };
  const { ctx, removed } = load(WIZ, () => new Promise((r) => { answer = r; }));
  const step = ctx.wizSubscriptionStep(ROW);
  await new Promise((r) => setImmediate(r));
  // Cancel while stepping: wizDropUnfinished defers the drop to the step.
  WIZ.phase = null; WIZ.dropAfterStep = true;
  answer({ ok: true, models: [{ id: 'sonnet' }] });
  await step;
  assert.equal(WIZ.phase, null, 'the closed wizard does not reopen on the model step');
  assert.deepEqual(removed, ['claude-code']);
  assert.equal(WIZ.unfinishedId, null);
});
