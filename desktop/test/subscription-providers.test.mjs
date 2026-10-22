// ATO-844: Add provider offers Claude Code and Codex again, with the TUI's
// labels (#710), and saves them as the TUI's wizard does. renderer.js is read
// as text and the pieces run in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}

function load(present) {
  const asked = [];
  const ctx = createContext({
    THIS_MACHINE: 'this Mac',
    WIZ: { row: null },
    render() {},
    BR: { providerKeyPresent: (q) => { asked.push(q); return Promise.resolve({ ok: true, present }); } },
  });
  runInContext(slice('const KIND_ROWS = [', '];') + '];'
    + slice('function wizService(row)', '\n') + '\n'
    + slice('const WIZ_BILLING = new Map();', 'async function wizSubscriptionStep(k)')
    + ';this.rows = KIND_ROWS; this.entry = wizSubscriptionEntry; this.lines = wizSubscriptionLines; this.service = wizService;', ctx);
  return { ctx, asked };
}

test('both subscription rows are offered with the terminal labels, after the one-key services', () => {
  const { ctx } = load(false);
  // Arrays built in the vm belong to its realm: compare a plain copy.
  const ids = JSON.parse(JSON.stringify(ctx.rows.map((k) => k.id)));
  assert.equal(ids[0], 'openrouter', 'row 0 stays OpenRouter');
  assert.deepEqual(ids.slice(3, 5), ['claude-cli', 'codex-cli']);
  assert.equal(ctx.rows[3].label, 'Claude Code subscription: the agent runs on your plan (signed-in `claude`)');
  assert.equal(ctx.rows[4].label, 'OpenAI Codex subscription: the agent runs on your plan (signed-in `codex`)');
  assert.equal(ctx.service(ctx.rows[3]), 'Claude Code');
  assert.ok(ctx.rows[ctx.rows.length - 1].custom, 'the custom row stays last');
});

test('the saved entry is the one the TUI writes', () => {
  const { ctx } = load(false);
  const [claude, codex] = [ctx.rows[3], ctx.rows[4]];
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.entry(claude))),
    { id: 'claude-cli', kind: 'subscription-cli', subscriptionCli: { cli: 'claude' }, defaultChatModel: 'sonnet' });
  // Codex resolves its own model: no defaultChatModel at all, not "".
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.entry(codex))),
    { id: 'codex-cli', kind: 'subscription-cli', subscriptionCli: { cli: 'codex' } });
});

test('the step warns about per-token billing only when the variable is set', async () => {
  const off = load(false);
  assert.equal(off.ctx.lines(off.ctx.rows[3]).length, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(off.ctx.lines(off.ctx.rows[3]).length, 1);
  assert.equal(off.asked[0].apiKeyEnvVar, 'ANTHROPIC_API_KEY');

  const on = load(true);
  on.ctx.lines(on.ctx.rows[4]);
  await new Promise((r) => setTimeout(r, 0));
  const lines = on.ctx.lines(on.ctx.rows[4]);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].warn);
  assert.match(lines[1].text, /^OPENAI_API_KEY is set/);
  assert.equal(on.asked.length, 1, 'asked once per variable');
  for (const l of lines) assert.doesNotMatch(l.text, /—/);
});

test('Next on a subscription row takes the no-key path, and both setup screens draw it', () => {
  const step = slice('async function wizNextStep()', 'const key = document.getElementById');
  assert.match(step, /if \(k\.subscriptionCli\) return wizSubscriptionStep\(k\);/);
  assert.equal(renderer.split('if (k.subscriptionCli) {').length - 1, 2, 'the popover and the first-run screens');
  const sub = slice('async function wizSubscriptionStep(k)', 'async function wizNext()');
  assert.doesNotMatch(sub, /verifyProviderKey/);
  assert.match(sub, /wizActivate\(k, id, '', null\)/, 'Codex, with no model list, is activated as it is');
});
