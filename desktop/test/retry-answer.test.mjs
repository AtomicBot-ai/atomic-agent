// ATO-861: the last reply of a turn that ran no tool offers "Ask again".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));

function fixture(log, busy = false) {
  const c = vm.createContext({S: {log, busy, streamId: null}, esc: (s) => String(s), ic: (n) => '<i>' + n + '</i>', String});
  for (const name of ['isLastReply', 'plainTurnQuestion', 'msgActs']) vm.runInContext(functions.get(name), c);
  return c;
}
const again = (html) => (/data-resend="([^"]+)"[^>]*title="Ask again"/.exec(html) || [])[1] || null;

test('a plain answer can be asked again, through its question', () => {
  const log = [{id: 'q1', k: 'user', text: 'Hi'}, {id: 'a1', k: 'assistant', text: 'Hello'}];
  const html = fixture(log).msgActs(log[1]);
  assert.equal(again(html), 'q1');
  assert.ok(html.indexOf('Ask again') < html.indexOf('Copy message'));
});

test('a turn that ran a tool or asked for approval has no retry, live or reopened', () => {
  for (const mid of [{id: 't', k: 'tool', name: 'os.fs.list_dir'}, {id: 'p', k: 'approval', stored: true}]) {
    const log = [{id: 'q1', k: 'user', text: 'List my files'}, mid, {id: 'a1', k: 'assistant', text: 'Here they are'}];
    assert.equal(again(fixture(log).msgActs(log[2])), null, mid.k);
  }
});

test('a steer belongs to the turn: the retry asks the question before it', () => {
  const log = [{id: 'q1', k: 'user', text: 'Hi'}, {id: 's', k: 'user', text: 'shorter', steered: true}, {id: 'a1', k: 'assistant', text: 'Hey'}];
  assert.equal(again(fixture(log).msgActs(log[2])), 'q1');
});

test('only the last reply, and never while a turn runs', () => {
  const log = [{id: 'q1', k: 'user', text: 'Hi'}, {id: 'a1', k: 'assistant', text: 'Hello'},
    {id: 'q2', k: 'user', text: 'And you?'}, {id: 'a2', k: 'assistant', text: 'Fine'}];
  assert.equal(again(fixture(log).msgActs(log[1])), null);
  assert.equal(again(fixture(log).msgActs(log[3])), 'q2');
  assert.equal(again(fixture(log, true).msgActs(log[3])), null);
});
