// ATO-723: Settings › Diagnostics opens the state and working folders, the
// agent's log and the model server's log through BR.openPath.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));

function fixture(platform, answer = {ok: true}) {
  const opened = [], toasts = [];
  const c = vm.createContext({
    PLATFORM: platform,
    DIAG: {copy: [], agentLog: '', log: null},
    BR: {openPath: async (p) => { opened.push(p); return answer; }},
    toast: (...a) => toasts.push(a),
    copyText() {}, diagLine: () => '', diagRepaint() {}, diagLogStop() {}, diagLogRefresh() {},
    String,
  });
  for (const name of ['diagAgentLogPath', 'diagOpen', 'diagAct']) vm.runInContext(functions.get(name), c);
  return {c, opened, toasts};
}
const settle = () => new Promise((res) => setTimeout(res, 0));

test('the agent log sits in the state folder, joined with the platform separator', () => {
  assert.equal(fixture('darwin').c.diagAgentLogPath('/Users/a/.atomic-agent'), '/Users/a/.atomic-agent/agent.log');
  assert.equal(fixture('darwin').c.diagAgentLogPath('/Users/a/.atomic-agent/'), '/Users/a/.atomic-agent/agent.log');
  assert.equal(fixture('win32').c.diagAgentLogPath('C:\\Users\\a\\.atomic-agent'), 'C:\\Users\\a\\.atomic-agent\\agent.log');
  assert.equal(fixture('darwin').c.diagAgentLogPath(''), '');
});

test('a row opens its folder, the log buttons open their files', async () => {
  const {c, opened} = fixture('darwin');
  c.DIAG.copy = [{label: 'State folder', value: '~/.atomic-agent', open: '/Users/a/.atomic-agent'}, {label: 'App', value: '0.0.3', open: ''}];
  c.DIAG.agentLog = '/Users/a/.atomic-agent/agent.log';
  c.DIAG.log = {path: '/Users/a/.atomic-agent/models/llama-server.log', external: false};
  c.diagAct('open:0'); c.diagAct('open:1'); c.diagAct('agentlog'); c.diagAct('openlog');
  await settle();
  assert.deepEqual(opened, ['/Users/a/.atomic-agent', '/Users/a/.atomic-agent/agent.log', '/Users/a/.atomic-agent/models/llama-server.log']);
});

test('nothing opens without a path, and a failed open says why', async () => {
  const {c, opened, toasts} = fixture('darwin', {ok: false, error: 'The file does not exist.'});
  c.diagAct('agentlog'); c.diagAct('openlog');
  c.DIAG.log = {path: null, external: true}; c.diagAct('openlog');
  await settle();
  assert.deepEqual(opened, []);
  c.DIAG.agentLog = '/x/agent.log'; c.diagAct('agentlog');
  await settle();
  assert.deepEqual(opened, ['/x/agent.log']);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], 'The file does not exist.');
  assert.equal(toasts[0][2], 'bad');
});
