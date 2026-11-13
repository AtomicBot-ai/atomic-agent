import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerSettingsReferenceIpc, parseSettingsJson, parseLegacyList, maskSettingValue, REMOTE_REFUSAL, OLDER_AGENT_NOTE } = require('../out/main/settings-reference.js');
const S = require('../renderer/all-settings.js');

/* ATO-41: Settings › Diagnostics' All settings. */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ic = () => '';

const ROWS = [
  { key: 'agent.maxSteps', type: 'number', default: 25, value: 40, description: 'Steps in one leg of a task.', envVar: null, settable: true },
  { key: 'agent.nameSessions', type: 'boolean', default: true, value: true, description: 'Ask the model to name each session.', envVar: null, settable: true },
  { key: 'localModels.completionMaxTokens', type: 'number', default: 16384, value: 16384, description: 'Reply cap.', envVar: 'ATOMIC_AGENT_LLAMA_MAX_TOKENS', settable: true },
  { key: 'projects.roots', type: 'string[]', default: [], value: [], description: '', envVar: null, settable: false },
  { key: 'web.search.exa.apiKeyEnv', type: 'string', default: 'EXA_API_KEY', value: '***', description: '', envVar: null, settable: true },
  { key: 'localModels.managed.parallel', type: "number | 'auto'", default: 'auto', value: 'auto', description: '', envVar: null, settable: true },
];

function harness(result, remote = false) {
  const handlers = {};
  const runs = [];
  registerSettingsReferenceIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    run: async (args) => { runs.push(args.join(' ')); return result; },
    isRemote: () => remote,
  });
  return { call: () => handlers['settings:reference'](), runs };
}

test('main asks the agent for `config list --json` and hands the rows over', async () => {
  const h = harness({ ok: true, stdout: JSON.stringify(ROWS), stderr: '' });
  const r = await h.call();
  assert.deepEqual(h.runs, ['config list --json']);
  assert.equal(r.ok, true);
  assert.equal(r.legacy, false);
  assert.equal(r.rows.length, ROWS.length);
  assert.equal(r.rows[2].envVar, 'ATOMIC_AGENT_LLAMA_MAX_TOKENS');
});

test('an older agent prints `key = value` lines: keys and values, read-only, with a note', async () => {
  const old = 'agent.maxSteps = 40  (default 25)\nlog.level = "info"\nweb.search.exa.apiKeyEnv = ***\n';
  const r = await harness({ ok: true, stdout: old, stderr: '' }).call();
  assert.equal(r.ok, true);
  assert.equal(r.legacy, true);
  assert.equal(r.note, OLDER_AGENT_NOTE);
  assert.deepEqual(r.rows.map((x) => [x.key, x.value, x.default, x.settable]), [
    ['agent.maxSteps', 40, 25, false],
    ['log.level', 'info', 'info', false],
    ['web.search.exa.apiKeyEnv', '***', '***', false],
  ]);
});

test('secrets inside a value never reach the screen, from a new or an older agent', async () => {
  const servers = [{name: 'gh', env: {GITHUB_TOKEN: 'ghp_abc'}, transport: {kind: 'streamable_http', url: 'https://x.invalid', headers: {Authorization: 'Bearer sk-live'}}}];
  // An older agent's plain `config list` prints the list whole.
  const old = `mcp.servers = ${JSON.stringify(servers)}  (default [])\ntelegram.botToken = "123:abc"\nagent.tokenBudget = 3000\n`;
  const legacy = await harness({ ok: true, stdout: old, stderr: '' }).call();
  assert.equal(legacy.legacy, true);
  assert.doesNotMatch(JSON.stringify(legacy.rows), /ghp_abc|sk-live|123:abc/);
  assert.deepEqual(legacy.rows[0].value[0].env, {GITHUB_TOKEN: '***'});
  assert.equal(legacy.rows[0].value[0].transport.url, 'https://x.invalid');
  assert.equal(legacy.rows[1].value, '***');
  assert.equal(legacy.rows[2].value, 3000);
  // A JSON row that still carries one (an agent before the recursive mask) is masked here too.
  const json = await harness({ ok: true, stdout: JSON.stringify([{key: 'mcp.servers', type: 'McpServerConfig[]', default: [], value: servers, description: '', envVar: null, settable: false}]), stderr: '' }).call();
  assert.doesNotMatch(JSON.stringify(json.rows), /ghp_abc|sk-live/);
  assert.deepEqual(maskSettingValue('some.headers', {'X-Key': 5, on: true}), {'X-Key': '***', on: true});
});

test('no answer is an error in the CLI words; a remote agent is refused without running', async () => {
  const r = await harness({ ok: false, stdout: '', stderr: 'config list failed: boom\n' }).call();
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  const remote = harness({ ok: true, stdout: '[]' }, true);
  assert.deepEqual(await remote.call(), { ok: false, error: REMOTE_REFUSAL });
  assert.deepEqual(remote.runs, []);
});

test('parsers keep only well-formed rows', () => {
  assert.equal(parseSettingsJson('nope'), null);
  assert.deepEqual(parseSettingsJson('[{"key":"a.b"},{"nokey":1}]').map((r) => r.key), ['a.b']);
  assert.deepEqual(parseLegacyList('garbage\n\n'), []);
});

test('search needs every word, in key, description or env variable', () => {
  assert.deepEqual(S.allSetFilter(ROWS, 'steps leg').map((r) => r.key), ['agent.maxSteps']);
  assert.deepEqual(S.allSetFilter(ROWS, 'LLAMA_MAX').map((r) => r.key), ['localModels.completionMaxTokens']);
  assert.equal(S.allSetFilter(ROWS, '').length, ROWS.length);
});

test('only plain values outside the panels that own them are editable', () => {
  const kind = (key) => S.allSetEditKind(ROWS.find((r) => r.key === key));
  assert.equal(kind('agent.maxSteps'), 'text');
  assert.equal(kind('agent.nameSessions'), 'bool');
  assert.equal(kind('projects.roots'), '');            // a list
  assert.equal(kind('web.search.exa.apiKeyEnv'), '');  // credential-shaped
  assert.equal(kind('localModels.completionMaxTokens'), '');  // the Models panel owns it
  assert.equal(S.allSetIsSecret('telegram.botToken'), true);
  assert.equal(S.allSetIsSecret('agent.tokenBudget'), false);
});

test('a draft becomes the typed value the config takes', () => {
  const row = (key) => ROWS.find((r) => r.key === key);
  assert.deepEqual(S.allSetCoerce(row('agent.maxSteps'), ' 40 '), { ok: true, value: 40 });
  assert.equal(S.allSetCoerce(row('agent.maxSteps'), 'lots').ok, false);
  assert.deepEqual(S.allSetCoerce(row('agent.nameSessions'), 'false'), { ok: true, value: false });
  assert.equal(S.allSetCoerce(row('agent.nameSessions'), 'maybe').ok, false);
  assert.deepEqual(S.allSetCoerce(row('localModels.managed.parallel'), '4'), { ok: true, value: 4 });
  assert.deepEqual(S.allSetCoerce(row('localModels.managed.parallel'), 'auto'), { ok: true, value: 'auto' });
  assert.equal(S.allSetCoerce(row('agent.maxSteps'), '  ').ok, false);
  assert.deepEqual(S.allSetPatch('agent.task.maxSteps', 9), { agent: { task: { maxSteps: 9 } } });
});

test('the list shows value, default when changed, description and env override', () => {
  const st = { ...S.ALLSET, open: true, rows: ROWS, q: 'max' };
  const html = S.allSetListHTML(st, esc);
  assert.match(html, /agent\.maxSteps/);
  assert.match(html, /default 25/);
  assert.match(html, /Steps in one leg of a task\./);
  assert.match(html, /ATOMIC_AGENT_LLAMA_MAX_TOKENS wins over this/);
  assert.doesNotMatch(html, /agent\.nameSessions/);
  assert.match(S.allSettingsHTML({ ...S.ALLSET, open: false }, { esc, ic }), /Show all settings/);
});

test('open loads the rows; save writes the typed value through the config path and reloads', async () => {
  const st = S.ALLSET;
  Object.assign(st, { open: false, rows: null, busy: false, err: '', msg: '', editKey: null, draft: '' });
  let rows = ROWS;
  const br = { settingsReference: async () => ({ ok: true, rows, legacy: false }) };
  const writes = [];
  const deps = {
    write: async (key, value, patch) => { writes.push([key, value, patch]); rows = ROWS.map((r) => (r.key === key ? { ...r, value } : r)); return { ok: true, live: true }; },
    unset: async () => ({ ok: true }),
  };
  await S.allSettingsAct('open', br, deps);
  assert.equal(st.open, true);
  assert.equal(st.rows.length, ROWS.length);
  await S.allSettingsAct('edit:agent.maxSteps', br, deps);
  assert.equal(st.editKey, 'agent.maxSteps');
  assert.equal(st.draft, '40');
  st.draft = '12';
  await S.allSettingsAct('save', br, deps);
  assert.deepEqual(writes, [['agent.maxSteps', 12, { agent: { maxSteps: 12 } }]]);
  assert.equal(st.editKey, null);
  assert.match(st.msg, /from the next message/);
  assert.equal(st.rows.find((r) => r.key === 'agent.maxSteps').value, 12);
  // A read-only row never opens an editor.
  await S.allSettingsAct('edit:projects.roots', br, deps);
  assert.equal(st.editKey, null);
});

test('a bad draft is refused before anything is written; reset unsets and asks for a restart', async () => {
  const st = S.ALLSET;
  Object.assign(st, { open: true, rows: ROWS, busy: false, err: '', msg: '', editKey: 'agent.maxSteps', draft: 'lots' });
  const br = { settingsReference: async () => ({ ok: true, rows: ROWS }) };
  const calls = [];
  const deps = { write: async () => { calls.push('write'); return { ok: true }; }, unset: async (key) => { calls.push('unset ' + key); return { ok: true }; } };
  await S.allSettingsAct('save', br, deps);
  assert.match(st.err, /number/);
  assert.deepEqual(calls, []);
  await S.allSettingsAct('reset:agent.maxSteps', br, deps);
  assert.deepEqual(calls, ['unset agent.maxSteps']);
  assert.equal(st.restartHint, true);
});
