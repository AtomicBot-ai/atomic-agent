// ATO-720, ATO-721, ATO-722: Settings › Diagnostics opens on three health rows
// (Engine, Model, Provider), each with a mark and at most one way out, and the
// Provider row's Check runs a live key check only when pressed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));
const consts = new Map(ast.statements.filter(ts.isVariableStatement)
  .flatMap((n) => n.declarationList.declarations.map((d) => [d.name.getText(ast), n.getText(ast)])));

// Values made inside the vm context have its own prototypes, which deepStrictEqual tells apart.
const eq = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
const NAMES = ['diagScrub', 'diagHealthRows', 'diagEngineRow', 'diagModelRow', 'diagProviderRow', 'diagHealthHTML',
  'diagCheckProvider', 'diagNoteProviderError', 'diagProviderOk'];

function fixture(over = {}) {
  const verified = [], unverifiedSet = [];
  const g = {
    S: {live: {state: 'connected'}},
    ENGF: {f: null}, DWATCH: null,
    LLMP: {status: {daemonRunning: true, health: 'ok', activeModel: 'gemma-4-e4b'}, daemonPhase: null, statusBusy: false},
    SET: {health: {llamaReachable: true}},
    DIAG: {check: null, provErr: {}},
    UNVERIFIED: [],
    backend: 'local', routeLocal: true,
    provider: {id: 'local-llama', kind: 'llama-server'},
    verify: async () => ({ok: true, checked: true}),
  };
  Object.assign(g, over);
  const c = vm.createContext({
    S: g.S, ENGF: g.ENGF, DWATCH: g.DWATCH, LLMP: g.LLMP, SET: g.SET, DIAG: g.DIAG, UNVERIFIED: g.UNVERIFIED,
    KEY_CHAR_ERROR: 'That key has a character keys don’t have; paste it again.',
    NO_FUNDS_KEY_LINE: 'Key works, but the account has no funds.',
    selBackend: () => g.backend, engfRouteLocal: () => g.routeLocal, activeProvider: () => g.provider,
    activeModel: () => 'gemma-4-e4b', modelWord: (id) => (id === 'gemma-4-e4b' ? 'Gemma 4 E4B' : id),
    providerWord: (id) => ({openrouter: 'OpenRouter'})[id] || id,
    savedKeyInvalid: (p) => !!p.badChars, savedKeyLine: (id) => 'The key saved for ' + id + ' has a character keys don’t have; paste it again.',
    llmJustSpawned: () => false,
    esc: (x) => String(x), diagRepaint() {},
    BR: {
      verifyProviderKey: async (entry, model) => { verified.push({entry, model}); return g.verify(); },
      unverifiedSet: async (id, on) => { unverifiedSet.push([id, on]); },
    },
    String, Object, Date, Promise,
  });
  for (const k of ['DIAG_NOT_USED_CLOUD', 'DIAG_DOT', 'DIAG_KEY_SHAPES']) vm.runInContext(consts.get(k), c);
  for (const n of NAMES) vm.runInContext(functions.get(n), c);
  // `UNVERIFIED = …` inside diagCheckProvider reassigns the context's binding.
  return {c, g, verified, unverifiedSet, rows: () => Object.fromEntries(c.diagHealthRows().map((r) => [r.key, r]))};
}
const cloud = {backend: 'cloud', routeLocal: false, provider: {id: 'openrouter', kind: 'openrouter', defaultChatModel: 'qwen/qwen3.8-27b'}};

test('a running local model: Engine and Model green, Provider grey', () => {
  const r = fixture().rows();
  assert.equal(r.engine.tone, 'ok'); assert.equal(r.engine.value, 'Ready');
  assert.equal(r.model.tone, 'ok'); assert.equal(r.model.value, 'Gemma 4 E4B · loaded');
  assert.equal(r.provider.tone, 'off');
  assert.equal(r.engine.fix, undefined); assert.equal(r.model.fix, undefined);
});

test('while the agent starts every row is checking, never red', () => {
  const r = fixture({S: {live: {state: 'starting'}}}).rows();
  eq([r.engine.tone, r.model.tone, r.provider.tone], ['wait', 'wait', 'wait']);
  const stopped = fixture({S: {live: {state: 'error'}}}).rows();
  eq([stopped.engine.tone, stopped.model.tone], ['off', 'off']);
});

test('the engine that did not install is red with Download again, unless it cannot help', () => {
  let r = fixture({ENGF: {f: {why: 'The download was interrupted.', at: 1}}}).rows();
  assert.equal(r.engine.tone, 'bad'); assert.equal(r.engine.value, 'The download was interrupted.');
  eq(r.engine.fix, {act: 'engf:retry', label: 'Download again'});
  r = fixture({ENGF: {f: {why: 'This Mac is too old for the engine.', at: 1, retryable: false}}}).rows();
  assert.equal(r.engine.tone, 'bad'); assert.equal(r.engine.fix, null);
  r = fixture({DWATCH: {kind: 'gave_up'}}).rows();
  assert.equal(r.engine.tone, 'bad'); assert.equal(r.engine.fix.act, 'diag:startModel');
  assert.equal(fixture({DWATCH: {kind: 'restarting'}}).rows().engine.tone, 'wait');
});

test('a stopped model is red with Start model; an external server sends to Models', () => {
  const down = {LLMP: {status: {daemonRunning: false, health: 'down'}, daemonPhase: null}, SET: {health: {llamaReachable: false}}};
  let r = fixture(down).rows();
  assert.equal(r.model.tone, 'bad'); assert.equal(r.model.value, 'The model server is not answering');
  eq(r.model.fix, {act: 'diag:startModel', label: 'Start model'});
  r = fixture({...down, backend: 'custom', routeLocal: false}).rows();
  assert.equal(r.model.tone, 'bad'); assert.equal(r.model.fix.act, 'settings:llm');
  assert.equal(r.engine.tone, 'off');
  assert.equal(fixture({LLMP: {status: {daemonRunning: true, health: 'loading'}, daemonPhase: null}, SET: {health: {llamaReachable: false}}}).rows().model.tone, 'wait');
  assert.equal(fixture({LLMP: {status: null, daemonPhase: null, statusBusy: true}, SET: {health: {llamaReachable: false}}}).rows().model.tone, 'wait');
});

test('a server that refuses its model key (agent with #721) is red, not "not answering"', () => {
  const r = fixture({LLMP: {status: {daemonRunning: true, health: 'key rejected'}, daemonPhase: null}, SET: {health: {llamaReachable: false}}}).rows();
  assert.equal(r.model.tone, 'bad'); assert.match(r.model.value, /refuses the model/);
  assert.equal(r.model.fix.act, 'settings:llm');
});

test('on a cloud provider Engine and Model are grey and the Provider row reads its state', () => {
  let f = fixture(cloud);
  let r = f.rows();
  assert.equal(r.engine.tone, 'off'); assert.equal(r.model.tone, 'off');
  assert.equal(r.provider.tone, 'ok'); assert.equal(r.provider.value, 'OpenRouter · no errors');
  assert.equal(r.provider.check.disabled, false);
  f = fixture({...cloud, UNVERIFIED: ['openrouter']});
  assert.equal(f.rows().provider.tone, 'warn');
  f = fixture(cloud);
  f.c.diagNoteProviderError('openrouter', 'API key rejected');
  r = f.rows();
  assert.equal(r.provider.tone, 'bad'); assert.equal(r.provider.value, 'OpenRouter · last error: API key rejected');
  eq(r.provider.fix, {act: 'settings:llm', label: 'Open provider settings'});
  f.c.diagProviderOk('openrouter');
  assert.equal(f.rows().provider.tone, 'ok');
  f = fixture({...cloud, provider: {...cloud.provider, badChars: true}});
  assert.equal(f.rows().provider.tone, 'bad');
  f = fixture({...cloud, provider: {id: 'openrouter', kind: 'openrouter'}});
  assert.equal(f.rows().provider.check.disabled, true);
});

test('Check asks for the saved key on the active model, and a pass clears the error and the badge', async () => {
  const f = fixture({...cloud, UNVERIFIED: ['openrouter']});
  f.c.diagNoteProviderError('openrouter', 'API key rejected');
  await new Promise((res) => setTimeout(res, 2));
  await f.c.diagCheckProvider();
  eq(f.verified, [{entry: {id: 'openrouter', kind: 'openrouter'}, model: 'qwen/qwen3.8-27b'}]);
  const r = f.rows();
  assert.equal(r.provider.tone, 'ok'); assert.equal(r.provider.value, 'OpenRouter · answering');
  eq(f.unverifiedSet, [['openrouter', false]]);
  assert.equal(vm.runInContext('UNVERIFIED.length', f.c), 0);
});

test('a rejected key reads with its status; an unchecked one says why; a later turn error wins', async () => {
  let f = fixture({...cloud, verify: async () => ({ok: false, checked: true, status: 401, error: 'the provider rejected this key: User not found'})});
  await f.c.diagCheckProvider();
  let r = f.rows();
  assert.equal(r.provider.tone, 'bad'); assert.equal(r.provider.value, 'OpenRouter did not accept the key (401)');
  assert.equal(r.provider.fix.act, 'settings:llm');
  eq(f.unverifiedSet, []);
  f = fixture({...cloud, verify: async () => ({ok: false, checked: false, error: 'no connection'})});
  await f.c.diagCheckProvider();
  assert.equal(f.rows().provider.tone, 'warn');
  assert.equal(f.rows().provider.value, 'Could not check OpenRouter: no connection');
  f = fixture(cloud);
  await f.c.diagCheckProvider();
  await new Promise((res) => setTimeout(res, 2));
  f.c.diagNoteProviderError('openrouter', 'the request timed out');
  assert.equal(f.rows().provider.value, 'OpenRouter · last error: the request timed out');
});

test('each row draws its mark, its words, Check on the provider and one fix button', () => {
  const f = fixture({...cloud, ENGF: {f: {why: 'Broken', at: 1}}, routeLocal: true, backend: 'local'});
  const html = f.c.diagHealthHTML(f.c.diagHealthRows());
  assert.match(html, /data-health="engine" data-tone="bad"/);
  assert.match(html, /tk-dot--red/);
  assert.match(html, /data-act="engf:retry">Download again</);
  assert.match(html, /data-act="diag:check"/);
  assert.equal((html.match(/set-diagfix/g) || []).length, 1);
  assert.doesNotMatch(html, /set-diagrow/);   // the support rows' Copy contract (T49) stays theirs
});

test('a provider error that quotes the key back loses the key before it is kept or shown', () => {
  const f = fixture(cloud);
  f.c.diagNoteProviderError('openrouter', 'Incorrect API key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 (Bearer abcdefgh12345678)');
  const r = f.rows();
  assert.equal(r.provider.tone, 'bad');
  assert.doesNotMatch(r.provider.value, /abcdefghijklmnop|abcdefgh12345678/);
  assert.match(r.provider.value, /Incorrect API key <key hidden> \(Bearer <key hidden>\)/);
});
