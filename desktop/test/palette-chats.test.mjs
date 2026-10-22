// ATO-824: a ⌘K search shows the first five matching chats, then one
// "N more chats" row, then tasks and skills. The row opens every matching
// chat for that query in place; a new query starts folded again.
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

function fixture(chatCount, q = 'report') {
  const acted = [];
  let repaints = 0;
  const c = vm.createContext({
    S: {scope: null, q, cur: 0, palMoreFor: null},
    PAL: [['Go', [['chat', 'Chat', '', '⌘ 1', 'room:chat']]]],
    SCOPES: {},
    SESSIONS: Array.from({length: chatCount}, (_, i) => ({id: 'c' + i, t: 'Weekly report ' + i})),
    TASKS: [{t: 'Report digest', when: 'daily'}],
    SKILLS: [{t: 'report-writer', s: 'workspace'}],
    SK: {workingDir: null},
    chatStatusWord: () => 'read', chatDot: () => ['empty', ''], taskDot: () => ['empty', ''],
    ANX: {via() {}}, act: (a) => acted.push(a), refreshPalette: () => { repaints++; },
    String, Array,
  });
  vm.runInContext(consts.get('PAL_CHATS_SHOWN'), c);
  for (const n of ['palRows', 'flatPalRows', 'activatePal', 'palMoreChats']) vm.runInContext(functions.get(n), c);
  return {c, acted, repaints: () => repaints};
}
// Values made inside the vm context have its own prototypes, which deepStrictEqual tells apart.
const eq = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
const kinds = (rows) => rows.map((r) => (r.more ? 'more' : r.badge || 'cmd'));

test('five chats, then "N more chats", then tasks and skills', () => {
  const {c} = fixture(20);
  const rows = c.palRows();
  eq(kinds(rows), ['session', 'session', 'session', 'session', 'session', 'more', 'task', 'skill']);
  const more = rows[5];
  assert.equal(more.t, '15 more chats');
  assert.equal(more.badge, 'session');   // under the same Chats header, no header of its own
  eq(rows.slice(0, 5).map((r) => r.act), ['ses:c0', 'ses:c1', 'ses:c2', 'ses:c3', 'ses:c4']);
});

test('the row opens every matching chat in place, past the old 20, and keeps the palette open', () => {
  const {c, acted, repaints} = fixture(30);
  c.S.cur = 5;
  c.activatePal(5);
  eq(acted, []);
  assert.equal(repaints(), 1);
  const rows = c.palRows();
  assert.equal(rows.filter((r) => r.badge === 'session').length, 30);
  assert.equal(rows.some((r) => r.more), false);
  eq(kinds(rows).slice(-2), ['task', 'skill']);
  assert.equal(rows[c.S.cur].act, 'ses:c5');   // the highlight lands on the sixth chat
  c.activatePal(c.S.cur);
  eq(acted, ['ses:c5']);
});

test('a different query starts folded again', () => {
  const {c} = fixture(12);
  c.palMoreChats();
  assert.equal(c.palRows().filter((r) => r.badge === 'session').length, 12);
  c.S.q = 'weekly';
  const rows = c.palRows();
  assert.equal(rows.filter((r) => r.badge === 'session' && !r.more).length, 5);
  assert.equal(rows.find((r) => r.more).t, '7 more chats');
});

test('six or fewer matches show them all, with no "1 more chats" row', () => {
  for (const n of [1, 5, 6]) {
    const rows = fixture(n).c.palRows();
    assert.equal(rows.filter((r) => r.badge === 'session').length, n);
    assert.equal(rows.some((r) => r.more), false);
  }
  assert.equal(fixture(7).c.palRows().find((r) => r.more).t, '2 more chats');
});

test('an empty query still draws the grouped commands, with no chats', () => {
  assert.equal(fixture(20, '').c.palRows(), null);
});
