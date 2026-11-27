// ATO-2743: the Tasks feature had four visible names ("Cron jobs" in Settings,
// the sidebar and the View menu, "Tasks" elsewhere, "Scheduled jobs" in Import,
// and its webhooks hidden behind "Cron jobs"). It is "Scheduled tasks"
// everywhere now, as in ChatGPT and Claude. Ids, acts, IPC and `atag cron` stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const {SCHEDULED_TASKS_LABEL, sidebarNavItems} = require('../renderer/sidebar-nav.js');
const {fuzzyRank, fuzzyFilter} = require('../renderer/fuzzy-match.js');

const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));
const consts = new Map(ast.statements.filter(ts.isVariableStatement)
  .flatMap((n) => n.declarationList.declarations.map((d) => [d.name.getText(ast), n.getText(ast)])));
/** A top-level literal const of renderer.js, evaluated on its own. */
const literal = (name) => vm.runInContext(consts.get(name) + '; ' + name, vm.createContext({}));
const menu = readFileSync(new URL('../main/menu.ts', import.meta.url), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the one name is "Scheduled tasks", and it is not the Task board', () => {
  assert.equal(SCHEDULED_TASKS_LABEL, 'Scheduled tasks');
  const rows = sidebarNavItems(null);
  assert.equal(rows.find((n) => n.id === 'tasks').label, SCHEDULED_TASKS_LABEL);
  assert.equal(rows.find((n) => n.id === 'board').label, 'Task board', 'the board keeps its own name');
});

test('the sidebar row, the View menu, the palette and Settings all spell the same name', () => {
  const sidebar = sidebarNavItems(null).find((n) => n.act === 'room:tasks').label;
  assert.match(menu, new RegExp('item\\("' + esc(sidebar) + '", "room:tasks", "CommandOrControl\\+2"\\)'), 'View menu');
  const palRow = literal('PAL').flatMap(([, rows]) => rows).find((r) => r[4] === 'settings:tasks' && r[2] === 'Settings');
  assert.equal(palRow[1], sidebar, 'palette');
  assert.equal(literal('SETTINGS_SECTIONS').find((s) => s[0] === 'tasks')[1], sidebar, 'Settings section');
  assert.equal(literal('SETTINGS_TABS').find((t) => t[0] === 'tasks')[1], sidebar, 'Settings pane');
  assert.match(source, new RegExp("if \\(S\\.room === 'tasks'\\)  return '" + esc(sidebar) + "';"), 'room title');
  assert.match(source, new RegExp('<div class="sb-list-head micro"><span>' + esc(sidebar) + '</span>'), 'sidebar list header');
  assert.match(source, new RegExp("task:'" + esc(sidebar) + "', skill:'Skills'"), 'palette group header');
  assert.equal(literal('IMP_TOGGLE_TITLES').cron, sidebar, 'Import toggle');
});

test('no visible string in the desktop still says "Cron jobs" or "Scheduled jobs"', () => {
  const files = ['../renderer/renderer.js', '../renderer/sidebar-nav.js', '../renderer/workboard.js', '../main/menu.ts'];
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const bad = [];
    const walk = (n) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /\b(cron|scheduled) jobs?\b/i.test(n.text)) bad.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    // The import step's developer note names the source app's own file ("Scheduled jobs (cron/jobs.json)"),
    // and the palette row's search words keep the old name findable.
    const allowed = (s) => /^Scheduled jobs \((cron\/jobs\.json|state\/openclaw\.sqlite cron_jobs)\) -> tasks\.sqlite$/.test(s)
      || s === 'cron jobs schedule automation webhooks' || s === 'open Scheduled tasks (cron jobs and webhooks)';
    assert.deepEqual(bad.filter((s) => !allowed(s)), [], f);
  }
});

function palette(q) {
  const c = vm.createContext({
    S: {scope: null, q, cur: 0, palMoreFor: null}, SCOPES: {}, SESSIONS: [], TASKS: [], SKILLS: [], SK: {workingDir: null},
    chatStatusWord: () => '', folderPaletteWord: () => '', chatDot: () => ['empty', ''], taskDot: () => ['empty', ''],
    fuzzyRank, fuzzyFilter, BR: null, String, Array, Set,
  });
  vm.runInContext(consts.get('PAL'), c);
  vm.runInContext(consts.get('PAL_CHATS_SHOWN'), c);
  vm.runInContext(consts.get('PALMSG'), c);
  for (const n of ['palRows', 'palMsgAsk', 'palMsgSnippet']) vm.runInContext(functions.get(n), c);
  return JSON.parse(JSON.stringify(c.palRows())).map((r) => [r.t, r.act]);
}

test('the old words still find it in the palette: cron, jobs, schedule, automation, webhook', () => {
  for (const q of ['cron', 'jobs', 'schedule', 'automation', 'webhook']) {
    assert.ok(palette(q).some(([t, a]) => t === SCHEDULED_TASKS_LABEL && a === 'settings:tasks'), q);
  }
});

test('Webhooks has its own palette row, opening the Webhooks pane of Scheduled tasks', () => {
  const hit = palette('webhooks').find(([t]) => t === 'Webhooks');
  assert.deepEqual(hit, ['Webhooks', 'settings:webhooks']);
  assert.deepEqual(literal('SETTINGS_SECTIONS').find((s) => s[0] === 'tasks')[3], ['tasks', 'webhooks']);
});

test('"task" lists Scheduled tasks and Task board as two separate rows', () => {
  const rows = palette('task');
  assert.ok(rows.some(([t, a]) => t === SCHEDULED_TASKS_LABEL && a === 'settings:tasks'));
  assert.ok(rows.some(([t, a]) => t === 'Task board' && a === 'board:open'));
});

test('a row\'s search words rank after its title and context, and only by word start', () => {
  assert.equal(fuzzyRank('cron', 'scheduled tasks', {kw: 'cron jobs'}), 4);
  assert.equal(fuzzyRank('obs', 'scheduled tasks', {kw: 'cron jobs'}), fuzzyRank('obs', 'scheduled tasks', {}));
  assert.equal(fuzzyRank('sched', 'scheduled tasks', {kw: 'cron'}), 1, 'the title still wins');
});
