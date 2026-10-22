// ATO-730: the model chip lists every model in groups, the current route's
// group first, each cloud group loading on its own. renderer.js is read as
// text and the grouping runs in a vm with its neighbours stubbed.
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

// Arrays built in the vm belong to its realm: compare a plain copy.
const plain = (v) => JSON.parse(JSON.stringify(v));

function load({ backend, active, providers, ready, local = [], models = [], lists = {} }) {
  const asked = [];
  const SEL = { open: true, kind: 'model', filter: '', models, modelsBusy: false, modelsErr: null, local, localBusy: false };
  const ctx = createContext({
    THIS_MACHINE: 'this Mac',
    SEL,
    BSW: { readyIds: ready },
    SEL_LIVE_MODELS: new Map(),
    selProviders: () => providers,
    selBackend: () => backend,
    selActiveProviderId: () => active,
    providerWord: (id) => ({ openrouter: 'OpenRouter', gemini: 'Gemini' })[id] || id,
    modelMatches: (id, tags, f) => (id + ' ' + tags).toLowerCase().includes(f),
    fmtContextWindow: (n) => String(n),
    hostRamGb: () => 32,
    orderModelsByFit: (ms) => ms,
    onDiskFirst: (ms) => ms,
    // As the real one: the local models through the search box.
    selLocalMatches: () => local.filter((m) => !SEL.filter || m.id.toLowerCase().includes(SEL.filter.toLowerCase())),
    fitFor: () => ({ v: 'ok' }),
    modelPickNote: () => null,
    modelDiskFit: () => ({ ok: true }),
    llmModelName: (m) => m.id,
    modelBlurb: () => '',
    modelSizeWord: () => '',
    modelListFailLine: (res) => (res && res.status === 401 ? 'did not accept the saved key (401).' : ''),
    selLoadLocal: () => asked.push('local'),
    render: () => {},
    queueMicrotask: () => {},
    BR: { providerModels: (id) => { asked.push(id); return Promise.resolve(lists[id] || { ok: true, models: [] }); } },
  });
  runInContext(slice('function selLocalRows(custom)', 'async function selActivate(row)')
    + ';this.grouped = selGroupedRows; this.cloudRows = selCloudRows; this.loadGroups = selLoadGroups; this.GROUPS = SEL_GROUPS;', ctx);
  return { ctx, asked };
}

const providers = [{ id: 'openrouter', kind: 'openrouter' }, { id: 'gemini', kind: 'gemini' }, { id: 'nokey', kind: 'openai-compatible' }];
const local = [{ id: 'gemma', downloaded: true, active: true }, { id: 'qwen', downloaded: false, active: false }];

test('on the local route, local is first, then each cloud provider with a working key', () => {
  const { ctx } = load({ backend: 'local', active: 'local-llama', providers, ready: ['openrouter', 'gemini'], local });
  const rows = ctx.grouped('local-llama', [{ type: 'localModel', id: 'gemma', active: true }]);
  assert.deepEqual(plain(ctx.SEL.groups.map((g) => g.id)), ['local-llama', 'openrouter', 'gemini']);
  assert.equal(ctx.SEL.groups[0].title, 'On this computer');
  assert.equal(ctx.SEL.groups[1].title, 'OpenRouter');
  assert.ok(ctx.SEL.groups[1].busy, 'a provider not asked yet reads loading');
  assert.equal(rows[0].group, 'local-llama');
  assert.ok(!ctx.SEL.groups.some((g) => g.id === 'nokey'), 'no key, no group');
});

test('on the cloud route the active provider is first, then the downloaded local models, none of them current', () => {
  const { ctx } = load({ backend: 'cloud', active: 'gemini', providers, ready: ['openrouter', 'gemini'], local });
  ctx.GROUPS.set('openrouter', { models: [{ id: 'openrouter/auto' }] });
  const current = ctx.cloudRows('gemini', [{ id: 'gemini-2.5-flash' }, { id: 'gemini-pro' }], 'gemini-2.5-flash');
  const rows = ctx.grouped('gemini', current);
  assert.deepEqual(plain(ctx.SEL.groups.map((g) => g.id)), ['gemini', 'local-llama', 'openrouter']);
  const by = (g) => rows.filter((r) => r.group === g).map((r) => r.id + (r.active ? '*' : ''));
  assert.deepEqual(plain(by('gemini')), ['gemini-2.5-flash*', 'gemini-pro']);
  assert.deepEqual(plain(by('local-llama')), ['gemma'], 'only what is on disk, and not marked current');
  assert.deepEqual(plain(by('openrouter')), ['openrouter/auto']);
  assert.equal(rows.find((r) => r.id === 'openrouter/auto').provider, 'openrouter', 'a row knows whose model it is');
});

test('the search filters every group at once', () => {
  const { ctx } = load({ backend: 'cloud', active: 'gemini', providers, ready: ['openrouter', 'gemini'], local });
  ctx.SEL.filter = 'auto';
  ctx.GROUPS.set('openrouter', { models: [{ id: 'openrouter/auto' }, { id: 'openai/gpt-5' }] });
  const rows = ctx.grouped('gemini', ctx.cloudRows('gemini', [{ id: 'gemini-pro' }], null));
  assert.deepEqual(plain(rows.map((r) => r.id)), ['openrouter/auto']);
});

test('each group loads on its own: a refused key is that group’s line, the others still list', async () => {
  const { ctx, asked } = load({
    backend: 'local', active: 'local-llama', providers, ready: ['openrouter', 'gemini'], local,
    lists: { openrouter: { ok: true, models: [{ id: 'openrouter/auto' }] }, gemini: { ok: false, status: 401, error: 'http 401' } },
  });
  ctx.loadGroups();
  assert.deepEqual(asked.sort(), ['gemini', 'openrouter']);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  ctx.grouped('local-llama', []);
  const g = Object.fromEntries(ctx.SEL.groups.map((x) => [x.id, x]));
  assert.equal(g.openrouter.busy, false);
  assert.equal(g.openrouter.err, null);
  assert.match(g.gemini.err, /401/);
  ctx.loadGroups();
  assert.equal(asked.filter((id) => id === 'openrouter').length, 1, 'a list in hand is kept');
});

test('a cloud row is written to its own provider, and Fusion keeps its seat list', () => {
  const act = slice('async function selActivate(row)', 'function selPull(id)');
  assert.match(act, /const pid = row\.provider \|\| selActiveProviderId\(\);/);
  const rowsFn = slice('function selRows()', 'function selLocalRows(custom)');
  const fusion = rowsFn.indexOf("selBackend() === 'fusion') return composerSeatModelRows()");
  assert.ok(fusion > 0 && fusion < rowsFn.indexOf('selGroupedRows('), 'Fusion returns before any grouping');
  assert.match(rowsFn, /return custom \? rows : selGroupedRows\('local-llama', rows\);/, 'the custom route is not grouped');
});
