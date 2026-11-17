import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../renderer/suggestion-cards.js');
const M = require('../out/main/ideas-ipc.js');

// ATO-458: the agent's suggested tasks (Retry / Resume) on the empty chat screen.

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const idea = (o = {}) => ({id: 'a1', kind: 'retry_task', status: 'new', title: 'Retry: build the report', reason: 'It failed and was never run again.', sessionId: null, ...o});

function reset() {
  R.IDEAS.ideas = []; R.IDEAS.loaded = false; R.IDEAS.unsupported = false;
  R.IDEAS.pending = null; R.IDEAS.askedAt = 0; R.IDEAS.busy = null;
}

test('a refresh answer gives the undecided ideas, cleaned', () => {
  const out = R.ideasOf({ideas: [idea(), idea({id: 'b2', kind: 'resume_goal', title: 'Resume the goal'}), idea({id: 'c3', status: 'dismissed'}), {id: '', title: 'x'}, null]});
  assert.deepEqual(out.map((i) => i.id), ['a1', 'b2']);
  assert.equal(out[1].kind, 'resume_goal');
  assert.deepEqual(R.ideasOf(null), []);
  assert.deepEqual(R.ideasOf({ideas: 'nope'}), []);
});

test('nothing to suggest draws nothing; cards are escaped and capped', async () => {
  reset();
  R.IDEAS.loaded = true;
  assert.equal(R.ideaCardsHTML(0), '');
  R.IDEAS.ideas = R.ideasOf({ideas: [idea({title: '<b>x</b>'}), idea({id: 'b'}), idea({id: 'c'}), idea({id: 'd'})]});
  const html = R.ideaCardsHTML(0);
  assert.equal((html.match(/class="ideacard"/g) || []).length, R.IDEA_CARDS_MAX);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /data-act="idea:start:a1"/);
  assert.match(html, /data-act="idea:dismiss:a1"/);
  assert.match(html, />Retry</);
});

test('refresh fills the cards; an agent without the routes shows none', async () => {
  reset();
  await R.ideaCardsRefresh({ideasRefresh: async () => ({ok: true, data: {ideas: [idea()]}})}, 1);
  assert.equal(R.IDEAS.ideas.length, 1);
  assert.equal(R.IDEAS.loaded, true);
  await R.ideaCardsRefresh({ideasRefresh: async () => ({ok: false, error: 'no route', unsupported: true})}, 2);
  assert.deepEqual(R.IDEAS.ideas, []);
  assert.equal(R.IDEAS.unsupported, true);
  reset();
  assert.deepEqual(await R.ideaCardsRefresh({}, 3), []);   // an older bridge
});

test('an agent still starting is asked again on a later paint, not on a timer', async () => {
  reset();
  let asks = 0;
  const br = {ideasRefresh: async () => { asks++; return {ok: false, error: 'fetch failed', unsupported: false}; }};
  await R.ideaCardsRefresh(br, 1000);
  assert.equal(R.IDEAS.loaded, false);
  // A paint inside the retry gap does not ask (BR is not defined here anyway).
  R.ideaCardsHTML(1000 + R.IDEA_RETRY_MS - 1);
  assert.equal(asks, 1);
  const s = src('../renderer/suggestion-cards.js');
  assert.doesNotMatch(s, /setInterval|setTimeout/);
});

test('Dismiss drops the card; Start files the task and opens its chat', async () => {
  reset();
  R.IDEAS.loaded = true;
  R.IDEAS.ideas = R.ideasOf({ideas: [idea(), idea({id: 'b2'})]});
  const calls = [];
  const br = {
    ideaDismiss: async (id) => { calls.push(['dismiss', id]); return {ok: true, data: {idea: {id}}}; },
    ideaAccept: async (id) => { calls.push(['accept', id]); return {ok: true, data: {idea: {id}, task: {id: 't1', status: 'pending', sessionId: 's9'}}}; },
  };
  await R.ideaCardsAct('dismiss:a1', br);
  assert.deepEqual(R.IDEAS.ideas.map((i) => i.id), ['b2']);
  const opened = [];
  globalThis.openSession = (sid) => opened.push(sid);
  try {
    await R.ideaCardsAct('start:b2', br);
  } finally {
    delete globalThis.openSession;
  }
  assert.deepEqual(calls, [['dismiss', 'a1'], ['accept', 'b2']]);
  assert.deepEqual(opened, ['s9']);
  assert.deepEqual(R.IDEAS.ideas, []);
  assert.equal(R.IDEAS.busy, null);
});

test('a card decided elsewhere (409) goes away; another failure keeps it', async () => {
  reset();
  R.IDEAS.ideas = R.ideasOf({ideas: [idea(), idea({id: 'b2'})]});
  await R.ideaCardsAct('dismiss:a1', {ideaDismiss: async () => ({ok: false, error: 'idea already decided', unsupported: false})});
  assert.deepEqual(R.IDEAS.ideas.map((i) => i.id), ['b2']);
  await R.ideaCardsAct('dismiss:b2', {ideaDismiss: async () => ({ok: false, error: 'fetch failed', unsupported: false})});
  assert.deepEqual(R.IDEAS.ideas.map((i) => i.id), ['b2']);
  assert.equal(R.ideaTaskSession({task: {sessionId: null}}), null);
});

test('main: the id is checked and a missing route reads as unsupported', async () => {
  assert.equal(M.cleanIdeaId('0b7c6f3e-1d2a-4c5b-9e8f-112233445566'), '0b7c6f3e-1d2a-4c5b-9e8f-112233445566');
  assert.equal(M.cleanIdeaId('../x'), null);
  assert.equal(M.cleanIdeaId(7), null);
  assert.equal(M.ideasUnsupported('no route for POST /api/ideas/refresh'), true);
  assert.equal(M.ideasUnsupported('tasks subsystem disabled'), true);
  assert.equal(M.ideasUnsupported('fetch failed'), false);
  assert.deepEqual(await M.ideaCall(async () => 1), {ok: true, data: 1});
  const bad = await M.ideaCall(async () => { throw new Error('no route'); });
  assert.equal(bad.ok, false);
  assert.equal(bad.unsupported, true);
});

test('wiring: script, stylesheet, bridge, main, client and the renderer hooks', () => {
  const html = src('../renderer/index.html');
  assert.ok(html.indexOf('src="suggestion-cards.js"') > 0 && html.indexOf('src="suggestion-cards.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.includes('href="css/suggestion-cards.css"'));
  const preload = src('../preload/preload.ts');
  for (const channel of ['agent:ideasRefresh', 'agent:ideaAccept', 'agent:ideaDismiss']) assert.ok(preload.includes(`"${channel}"`), channel);
  assert.match(src('../main/main.ts'), /wireIdeasIpc\(\{ client \}\)/);
  const client = src('../main/agent-client.ts');
  assert.match(client, /"\/api\/ideas\/refresh"/);
  assert.match(client, /\/api\/ideas\/\$\{encodeURIComponent\(id\)\}\/accept/);
  assert.match(client, /\/api\/ideas\/\$\{encodeURIComponent\(id\)\}\/dismiss/);
  const r = src('../renderer/renderer.js');
  assert.match(r, /ideaCardsHTML\(\)/);
  assert.match(r, /a\.startsWith\('idea:'\) && typeof ideaCardsAct === 'function'/);
  assert.equal((r.match(/ideaCardsRefresh\(\)/g) || []).length, 2);   // app start + each new chat
});
