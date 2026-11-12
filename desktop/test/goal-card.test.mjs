// Unit tests for ATO-1040 (goal mode in the composer, the progress card):
// the pure half of renderer/goal-card.js, main/session-goal.ts (against the
// built output) and the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../renderer/goal-card.js');
const M = require('../out/main/session-goal.js');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const deps = {esc: (s) => String(s), ic: (name) => '<svg data-ic="' + name + '"></svg>'};
const reset = () => { G.GOALS.clear(); G.GOAL_FOLD.clear(); G.GOAL_PENDING.clear(); };
/* A GoalState as the agent stores it (src/agent/goal/goal-types.ts). */
const goal = (status, marks, extra = {}) => ({
  version: 1, status, checks: [], maxRounds: 10, roundsUsed: 2, judgeFailures: 0, createdAt: 1, updatedAt: 5,
  criteria: marks.map((mark, i) => ({text: 'item ' + (i + 1), mark, ...(mark === 'not_met' || mark === 'blocked' ? {reason: 'why ' + (i + 1)} : {})})),
  ...extra,
});

/* ---------- reading what the agent sends ---------- */

test('a goal reads as status, marks with reasons and rounds; anything malformed is no goal', () => {
  const g = G.goalRead(goal('active', ['met', 'not_met', 'pending']));
  assert.equal(g.status, 'active');
  assert.deepEqual(g.criteria.map((c) => [c.mark, c.reason]), [['met', ''], ['not_met', 'why 2'], ['pending', '']]);
  assert.equal(G.goalSummary(g), '1/3 met · round 2/10');
  assert.equal(G.goalRead(null), null);
  assert.equal(G.goalRead({status: 'running', criteria: [{text: 'x', mark: 'met'}]}), null);
  assert.equal(G.goalRead({status: 'active', criteria: [{text: 'x', mark: 'odd'}]}), null);
});

test('a frame sets the chat\'s goal, an identical one changes nothing, null removes it', () => {
  reset();
  assert.equal(G.goalSet('s1', goal('active', ['pending'])), true);
  assert.equal(G.goalSet('s1', goal('active', ['pending'], {updatedAt: 99})), false);
  assert.equal(G.goalSet('s1', goal('active', ['met'])), true);
  assert.equal(G.goalOf('s1').criteria[0].mark, 'met');
  assert.equal(G.goalSet('s1', null), true);
  assert.equal(G.goalOf('s1'), null);
  assert.equal(G.goalSet('', goal('active', ['met'])), false);
});

test('a reopened chat keeps the streamed goal while its turn runs, unless the stored one is newer', () => {
  reset();
  G.goalSet('s1', goal('active', ['met', 'pending'], {updatedAt: 10}));
  assert.equal(G.goalRestore('s1', goal('active', ['pending', 'pending'], {updatedAt: 4}), true), false);
  assert.equal(G.goalOf('s1').criteria[0].mark, 'met');
  assert.equal(G.goalRestore('s1', goal('paused', ['met', 'met'], {updatedAt: 20}), true), true);
  assert.equal(G.goalOf('s1').status, 'paused');
  assert.equal(G.goalRestore('s1', null, false), true);
  assert.equal(G.goalOf('s1'), null);
});

test('a pause asked of a running goal is forgotten once the goal stops', () => {
  reset();
  G.goalSet('s1', goal('active', ['pending']));
  G.GOAL_PENDING.set('s1', 'pause');
  G.goalSet('s1', goal('active', ['met']));
  assert.equal(G.GOAL_PENDING.get('s1'), 'pause');
  G.goalSet('s1', goal('paused', ['met']));
  assert.equal(G.GOAL_PENDING.has('s1'), false);
});

/* ---------- the words and the buttons ---------- */

test('statuses and marks read as the TUI says them', () => {
  assert.equal(G.goalStatusLabel('budget_limited'), 'Round limit reached');
  assert.equal(G.goalStatusLabel('blocked'), 'Blocked');
  assert.deepEqual(['met', 'not_met', 'pending', 'blocked'].map(G.goalMarkWord), ['met', 'open', 'open', 'blocked']);
});

test('the buttons follow /goal pause, resume and clear', () => {
  const read = (s) => G.goalRead(goal(s, ['pending']));
  assert.deepEqual(G.goalActions(read('active'), true), ['pause', 'clear']);
  assert.deepEqual(G.goalActions(read('paused'), false), ['resume', 'clear']);
  assert.deepEqual(G.goalActions(read('blocked'), true), ['resume-wait', 'clear']);
  assert.deepEqual(G.goalActions(read('budget_limited'), false), ['resume', 'clear']);
  assert.deepEqual(G.goalActions(read('complete'), false), ['clear']);
  assert.deepEqual(G.goalActions(null, false), []);
});

test('the card draws status, rounds, every criterion with its reason, and its buttons', () => {
  reset();
  G.goalSet('s1', goal('blocked', ['met', 'blocked', 'not_met'], {statusReason: 'needs an API key'}));
  const html = G.goalCardHTML('s1', {...deps, busy: false});
  assert.match(html, /Goal · Blocked/);
  assert.match(html, /1\/3 met · round 2\/10/);
  assert.match(html, /needs an API key/);
  assert.match(html, /class="gl-it gl-met"[^]*item 1/);
  assert.match(html, /class="gl-it gl-blocked"[^]*item 2[^]*why 2/);
  assert.match(html, /class="gl-it gl-open"[^]*item 3[^]*why 3/);
  assert.match(html, /data-goal-act="resume"/);
  assert.match(html, /data-goal-act="clear"/);
  assert.doesNotMatch(html, /data-goal-act="pause"/);
  assert.equal(G.goalCardHTML('none', deps), '');
});

test('a folded card is its chip line; a pending pause disables the buttons and says so', () => {
  reset();
  G.goalSet('s1', goal('active', ['pending']));
  G.GOAL_FOLD.add('s1');
  assert.doesNotMatch(G.goalCardHTML('s1', deps), /gl-list/);
  G.GOAL_FOLD.delete('s1');
  G.GOAL_PENDING.set('s1', 'pause');
  const html = G.goalCardHTML('s1', deps);
  assert.match(html, /Pausing after this round/);
  assert.match(html, /data-goal-act="pause" disabled/);
});

/* ---------- the form ---------- */

test('the form reads criteria the way /goal does', () => {
  assert.deepEqual(G.goalParseForm('tests pass; docs updated', ''), {ok: true, criteria: ['tests pass', 'docs updated']});
  assert.deepEqual(G.goalParseForm('- tests pass\n2. docs; with a semicolon\n- tests pass', '4'),
    {ok: true, criteria: ['tests pass', 'docs; with a semicolon'], maxRounds: 4});
  assert.equal(G.goalParseForm('   ', '').ok, false);
  assert.equal(G.goalParseForm('ship it\ncheck: npm test', '').ok, false);
  assert.equal(G.goalParseForm('ship it', '0').ok, false);
  assert.equal(G.goalParseForm('ship it', '51').ok, false);
  assert.equal(G.goalParseForm('ship it', 'ten').ok, false);
  assert.equal(G.goalParseForm(Array.from({length: 21}, (_, i) => 'c' + i).join('\n'), '').ok, false);
});

test('the form keeps its draft and shows its error', () => {
  G.GOAL_FORM.open = false;
  assert.equal(G.goalFormHTML(deps), '');
  Object.assign(G.GOAL_FORM, {open: true, text: 'a <b>', rounds: '3', error: 'Too many'});
  const html = G.goalFormHTML({...deps, esc: (s) => String(s).replace(/</g, '&lt;')});
  assert.match(html, /id="goal-criteria"[^>]*>a &lt;b>/);
  assert.match(html, /id="goal-rounds"[^>]*value="3"/);
  assert.match(html, /Too many/);
  Object.assign(G.GOAL_FORM, {open: false, text: '', rounds: '', error: ''});
});

/* ---------- main: what reaches the agent ---------- */

test('main passes the four actions on, and keeps a set within the agent\'s bounds', () => {
  assert.deepEqual(M.goalIpcRequest({sessionId: 's1', body: {action: 'pause'}}), {ok: true, sessionId: 's1', body: {action: 'pause'}});
  assert.deepEqual(M.goalIpcRequest({sessionId: 's1', body: {action: 'set', criteria: [' a ', '', 3, 'b'], maxRounds: 5}}),
    {ok: true, sessionId: 's1', body: {action: 'set', criteria: ['a', 'b'], maxRounds: 5}});
  assert.equal(M.goalIpcRequest({sessionId: '', body: {action: 'pause'}}).ok, false);
  assert.equal(M.goalIpcRequest({sessionId: 'a/b', body: {action: 'pause'}}).ok, false);
  assert.equal(M.goalIpcRequest({sessionId: 's1', body: {action: 'run'}}).ok, false);
  assert.equal(M.goalIpcRequest({sessionId: 's1', body: {action: 'set', criteria: []}}).ok, false);
  assert.equal(M.goalIpcRequest({sessionId: 's1', body: {action: 'set', criteria: ['a'], maxRounds: 51}}).ok, false);
  assert.match(M.goalErrorText(new Error('No route for POST /api/sessions/s1/goal')), /no goal mode/);
  assert.equal(M.goalErrorText(new Error('the goal is already complete')), 'the goal is already complete');
});

/* ---------- wiring ---------- */

test('the window loads the card before renderer.js and draws it under the plan', () => {
  const html = src('../renderer/index.html');
  const card = html.indexOf('<script src="goal-card.js"');
  const actions = html.indexOf('<script src="goal-actions.js"');
  assert.ok(card > 0 && card < actions && actions < html.indexOf('<script src="renderer.js"'));
  assert.ok(html.includes('href="css/goal-card.css"'));
  const r = src('../renderer/renderer.js');
  assert.match(r, /planBarHTML\(S\.sessionId, \{esc, ic\}\) \+ goalBits \+ q/);
  assert.match(r, /ev\.kind === 'goal_progress'/);
  assert.match(r, /goalRestore\(id, data\.goal, live\)/);
  assert.match(r, /goalButtonHTML\(\{ic\}\)/);
});

test('preload, main and the client use the same routes', () => {
  const pre = src('../preload/preload.ts');
  assert.match(pre, /goalGet: \(sessionId: string\) => ipcRenderer\.invoke\("goal:get"/);
  assert.match(pre, /ipcRenderer\.invoke\("goal:action", \{ sessionId, body \}\)/);
  const ipc = src('../main/session-goal-ipc.ts');
  assert.match(ipc, /ipcMain\.handle\("goal:get"/);
  assert.match(ipc, /ipcMain\.handle\("goal:action"/);
  assert.match(src('../main/main.ts'), /wireSessionGoalIpc\(client\)/);
  assert.match(src('../main/agent-client.ts'), /"POST", `\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/goal`/);
});
