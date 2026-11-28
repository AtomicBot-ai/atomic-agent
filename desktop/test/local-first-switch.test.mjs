// ATO-2434: Settings › Models › Fallback chain › "Start on the local model",
// the desktop switch for llm.fallback.localFirst (ATO-2208). The module is
// pure (renderer/local-first-switch.js); renderer.js and index.html are read
// as text for the wiring. Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {localFirstView, createLocalFirstSwitch, localFirstSwitchHTML, LOCAL_FIRST_HINT} = require('../renderer/local-first-switch.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const local = {id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091'};
const cloud = {id: 'openrouter', kind: 'openrouter', model: 'm1'};
const external = {mode: 'external', url: 'http://127.0.0.1:8080'};

test('unset is off, and it can be turned on with a local and a cloud provider', () => {
  const v = localFirstView(undefined, [cloud, local], 'openrouter', external);
  assert.equal(v.on, false);
  assert.equal(v.disabled, false);
  assert.equal(v.reason, null);
  assert.equal(localFirstView({localFirst: true}, [cloud, local], 'openrouter', external).on, true);
});

test('no local provider: off and disabled with a reason', () => {
  const v = localFirstView({}, [cloud], 'openrouter', external);
  assert.equal(v.disabled, true);
  assert.equal(v.reason, 'Set up a local model first.');
});

test('managed local engine with no model chosen counts as no local model', () => {
  const managed = {mode: 'managed', url: local.url, managed: {modelId: null}};
  assert.equal(localFirstView({}, [cloud, local], 'openrouter', managed).disabled, true);
  const chosen = {mode: 'managed', url: local.url, managed: {modelId: 'qwen3-8b'}};
  assert.equal(localFirstView({}, [cloud, local], 'openrouter', chosen).disabled, false);
});

test('no cloud provider: off and disabled with a reason', () => {
  const v = localFirstView({}, [local], 'local-llama', external);
  assert.equal(v.disabled, true);
  assert.equal(v.reason, 'Add a cloud provider first.');
});

test('a switch already on is never stuck: it stays enabled to turn off', () => {
  const v = localFirstView({localFirst: true}, [cloud], 'openrouter', external);
  assert.equal(v.on, true);
  assert.equal(v.disabled, false);
});

test('on while the local model is active says it waits for a cloud model', () => {
  const v = localFirstView({localFirst: true}, [cloud, local], 'llama-server', external);
  assert.match(v.note, /once a cloud model is active/);
});

test('toggle writes the whole fallback object, keeping the chain and appendLocal', async () => {
  const writes = [];
  const said = [];
  let refreshed = 0;
  const sw = createLocalFirstSwitch({
    fallback: () => ({chain: ['openrouter', 'groq'], appendLocal: true}),
    write: async (next) => { writes.push(next); return {ok: true}; },
    refresh: async () => { refreshed++; },
    saved: (on) => said.push(on),
    repaint: () => {},
  });
  const res = await sw.toggle(localFirstView(undefined, [cloud, local], 'openrouter', external));
  assert.equal(res.ok, true);
  assert.deepEqual(writes, [{chain: ['openrouter', 'groq'], appendLocal: true, localFirst: true}]);
  assert.equal(refreshed, 1);
  assert.deepEqual(said, [true]);
  assert.equal(sw.state.busy, false);
});

test('toggle off writes localFirst false', async () => {
  const writes = [];
  const sw = createLocalFirstSwitch({fallback: () => ({localFirst: true}), write: async (n) => { writes.push(n); return {ok: true}; },
    refresh: async () => {}, saved: () => {}, repaint: () => {}});
  await sw.toggle(localFirstView({localFirst: true}, [cloud, local], 'openrouter', external));
  assert.deepEqual(writes, [{localFirst: false}]);
});

test('a disabled switch writes nothing', async () => {
  let wrote = false;
  const sw = createLocalFirstSwitch({fallback: () => ({}), write: async () => { wrote = true; return {ok: true}; },
    refresh: async () => {}, saved: () => {}, repaint: () => {}});
  const res = await sw.toggle(localFirstView({}, [cloud], 'openrouter', external));
  assert.equal(res.ok, false);
  assert.equal(wrote, false);
});

test('a failed write shows plain words, the raw error only behind Details', async () => {
  const raw = 'atag config set exited 1: EACCES /Users/x/.atomic-agent/config.json';
  const sw = createLocalFirstSwitch({fallback: () => ({}), write: async () => ({ok: false, error: raw}),
    refresh: async () => { throw new Error('must not refresh'); }, saved: () => { throw new Error('must not say saved'); }, repaint: () => {}});
  const view = localFirstView({}, [cloud, local], 'openrouter', external);
  assert.equal((await sw.toggle(view)).ok, false);
  assert.equal(sw.state.error, 'Could not save this setting. Try again.');
  assert.equal(sw.state.detail, raw);
  const html = localFirstSwitchHTML(view, sw.state, esc);
  const beforeDetails = html.slice(0, html.indexOf('<details'));
  assert.ok(html.includes('<summary>Details</summary>'));
  assert.ok(!beforeDetails.includes('EACCES'), 'the raw error is not in the visible line');
  assert.ok(html.includes('EACCES'), 'the raw error is behind Details');
});

test('the row: label, hint, switch action, and the reason when disabled', () => {
  const on = localFirstSwitchHTML(localFirstView({}, [cloud, local], 'openrouter', external), {busy: false}, esc);
  assert.ok(on.includes('Start on the local model'));
  assert.ok(on.includes(esc(LOCAL_FIRST_HINT)));
  assert.ok(on.includes('data-act="llm:fb:localFirst"'));
  const off = localFirstSwitchHTML(localFirstView({}, [cloud], 'openrouter', external), {busy: false}, esc);
  assert.ok(off.includes('Set up a local model first.'));
  assert.ok(!off.includes('data-act="llm:fb:localFirst"'), 'a disabled switch has no action');
  const busy = localFirstSwitchHTML(localFirstView({}, [cloud, local], 'openrouter', external), {busy: true}, esc);
  assert.ok(!busy.includes('data-act="llm:fb:localFirst"'), 'no second write while one is saving');
  assert.ok(busy.includes('tk-spin'));
});

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');

function fnBody(name) {
  const at = renderer.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, name + ' is a top-level function in renderer.js');
  return renderer.slice(at + 1, renderer.indexOf('\n}\n', at) + 2);
}

test('the Fallback chain pane draws the switch', () => {
  assert.ok(fnBody('llmFallbackHTML').includes('llmLocalFirstHTML()'));
});

test('the switch action toggles llm.fallback.localFirst through llmWrite', () => {
  assert.ok(renderer.includes("if (sub === 'localFirst') { llmLfs().toggle(llmLocalFirstNow()); return; }"));
  assert.match(fnBody('llmLfs'), /createLocalFirstSwitch\(\{fallback: \(\) => llmBlock\(\)\.fallback, write: \(next\) => llmWrite\('fallback', next\)/);
});

test('index.html loads the module and its styles before renderer.js', () => {
  const mod = html.indexOf('<script src="local-first-switch.js"></script>');
  assert.ok(mod >= 0);
  assert.ok(mod < html.indexOf('<script src="renderer.js"></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="css/local-first-switch.css">'));
});
