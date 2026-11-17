// ATO-1632: marks that already ship in renderer/logos/ but were not drawn.
// Pi and Oh-My-Pi in the import list, the Claude Code and Codex subscriptions
// (by row id, by saved entry, by label), and Claude Code's model aliases
// (sonnet, opus, haiku) get their real logo instead of the server or CPU badge.
//
// renderer.js is read as text; the pieces run in a vm. No deps, no build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');

function fn(name) {
  const at = source.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, name + ' is a top-level function in renderer.js');
  return source.slice(at + 1, source.indexOf('\n}\n', at) + 2);
}
function constBlock(name) {
  const at = source.indexOf('\nconst ' + name + ' = {');
  assert.ok(at >= 0, name + ' is a top-level const in renderer.js');
  return source.slice(at + 1, source.indexOf('\n};\n', at) + 3);
}

function load() {
  const ctx = createContext({ ic: (n) => '<i>' + n + '</i>' });
  runInContext([
    constBlock('LOGO_FILES'), constBlock('PROVIDER_LOGO_KEYS'),
    fn('modelLogoKey'), fn('providerLogoKey'), fn('logoHTML'), fn('markFallbackHTML'),
    fn('modelMark'), fn('providerMark'), fn('subscriptionLogoKey'), fn('llmProviderMark'), fn('wizKindMark'),
    'this.LOGO_FILES = LOGO_FILES;',
  ].join('\n'), ctx);
  return ctx;
}
const ctx = load();
const img = (html) => (String(html).match(/src="logos\/([^"]+)"/) || [])[1] || '';

test('every mark key points at a file that ships in renderer/logos/', () => {
  for (const [key, file] of Object.entries(ctx.LOGO_FILES)) {
    assert.ok(existsSync(new URL('../renderer/logos/' + file, import.meta.url)), key + ' -> ' + file);
  }
});

test('Pi and Oh-My-Pi wear their own marks (import list ids and labels)', () => {
  assert.equal(ctx.providerLogoKey('pi'), 'pi');
  assert.equal(ctx.providerLogoKey('oh-my-pi'), 'ohmypi');
  assert.equal(ctx.providerLogoKey('Oh-My-Pi'), 'ohmypi');
  assert.equal(img(ctx.providerMark('pi')), 'pi.svg');
  assert.equal(img(ctx.providerMark('oh-my-pi')), 'ohmypi.svg');
});

test('the subscription rows wear the CLI mark, not the server badge', () => {
  assert.equal(ctx.providerLogoKey('claude-cli'), 'claudecode');
  assert.equal(ctx.providerLogoKey('codex-cli'), 'codex');
  assert.equal(ctx.providerLogoKey('Claude Code subscription'), 'claudecode');
  assert.equal(ctx.providerLogoKey('Codex subscription'), 'codex');
  assert.equal(img(ctx.providerMark('claude-cli', 'sm')), 'claudecode-color.svg');
  assert.equal(img(ctx.providerMark('codex-cli', 'xs')), 'codex-color.svg');
});

test('a saved subscription entry wears its CLI mark whatever its id', () => {
  // A saved entry carries {cli}; a KIND_ROWS row carries the name; the id can be anything.
  assert.equal(img(ctx.llmProviderMark({ id: 'my-plan', kind: 'subscription-cli', subscriptionCli: { cli: 'claude' } })), 'claudecode-color.svg');
  assert.equal(img(ctx.llmProviderMark({ id: 'work', kind: 'subscription-cli', subscriptionCli: { cli: 'codex' } })), 'codex-color.svg');
  assert.equal(img(ctx.llmProviderMark({ id: 'codex-cli', kind: 'subscription-cli' })), 'codex-color.svg');
  assert.equal(img(ctx.wizKindMark({ id: 'claude-cli', kind: 'subscription-cli', subscriptionCli: 'claude' }, 'sm')), 'claudecode-color.svg');
  assert.equal(img(ctx.wizKindMark({ id: 'codex-cli', kind: 'subscription-cli', subscriptionCli: 'codex' }, 'sm')), 'codex-color.svg');
  // A subscription whose CLI has no mark keeps the server badge.
  assert.match(ctx.llmProviderMark({ id: 'x', kind: 'subscription-cli', subscriptionCli: { cli: 'other' } }), /tk-ico--mark/);
});

test('entries that are not subscriptions keep their old marks', () => {
  assert.equal(img(ctx.llmProviderMark({ id: 'openrouter', kind: 'openrouter' })), 'openrouter.svg');
  assert.equal(img(ctx.llmProviderMark({ id: 'mine', kind: 'gemini' })), 'gemini-color.svg');
  assert.match(ctx.llmProviderMark({ id: 'box', kind: 'openai-compatible' }), /tk-ico--mark/);
  assert.match(ctx.wizKindMark({ id: 'openai-compatible', custom: true }), /tk-ico--mark/);
  assert.equal(img(ctx.wizKindMark({ id: 'anthropic', kind: 'anthropic' })), 'anthropic.svg');
});

test('Claude Code model aliases wear the Claude mark', () => {
  for (const id of ['sonnet', 'opus', 'haiku', 'Sonnet', 'sonnet[1m]', 'opus-4', 'anthropic/haiku']) {
    assert.equal(ctx.modelLogoKey(id), 'claude', id);
  }
  assert.equal(img(ctx.modelMark('sonnet', 'xs')), 'claude-color.svg');
  // Not every id that happens to contain the letters.
  assert.equal(ctx.modelLogoKey('magnumopus-7b'), '');
  assert.equal(ctx.modelLogoKey('magnum-opus-72b'), '');
  assert.equal(ctx.modelLogoKey('Helsinki-NLP/opus-mt-en-de'), '');
  assert.equal(ctx.modelLogoKey('llama-3.1-8b'), '');
  assert.match(ctx.modelMark('llama-3.1-8b'), /tk-ico--mark/);
});
