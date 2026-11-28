// Settings › Connections › Discord (ATO-516), renderer side: the token and id
// rules, the effective `discord` block, the actions against a fake bridge, and
// the pane's markup. The helpers come from renderer/discord-settings.js;
// renderer.js and index.html are read as text for the wiring. Every token and
// id here is a dummy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../renderer/discord-settings.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (n) => '<i data-ic="' + n + '"></i>'};
const TOKEN = 'MTAxdummy.discord-token_0123456789abcdef';
const ID = '123456789012345678';
const ID2 = '223456789012345678';

/* A fake bridge: the config block, the .env token, and every call it got. */
function fakeApi(start = {}) {
  const calls = [];
  const s = {cfg: start.cfg || {enabled:false, ownerUserIds:[]}, token: start.token || null, gen: 1, blocked: false,
    fail: start.fail || {}, restartState: start.restartState || {state:'connected'}};
  const api = {
    readConfig: async () => (calls.push(['readConfig']), s.fail.read ? {ok:false, error:'read failed'} : {ok:true, value:JSON.parse(JSON.stringify(s.cfg))}),
    tokenPresent: async () => (calls.push(['tokenPresent']), {ok:true, has:s.token !== null}),
    setToken: async (v) => { calls.push(['setToken', v === null ? null : 'TOKEN']); if (s.fail.token) return {ok:false, error:'disk full'}; s.token = v; return {ok:true}; },
    write: async (entries) => {
      calls.push(['write', entries]);
      if (s.fail.write) return {ok:false, error:'config locked'};
      for (const [k, v] of entries) s.cfg[k.slice('discord.'.length)] = v;
      return {ok:true};
    },
    restart: async () => { calls.push(['restart']); s.gen++; return s.restartState; },
    restartBlocked: () => s.blocked,
    agentGen: () => s.gen,
  };
  return {api, calls, s};
}

test('a token is one run of printable characters, 20 to 200 long; the error never quotes it', () => {
  assert.deepEqual(D.dcTokenClean('  ' + TOKEN + '\n'), {ok:true, value:TOKEN});
  for (const bad of ['', '   ', 'short', 'two words in a discord token', 'k'.repeat(201)]) {
    const r = D.dcTokenClean(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.error.includes(bad) || bad.trim() === '', 'never quoted back');
  }
});

test('a user id is 15 to 25 digits; a pasted mention or @ is forgiven, and the error says where to find one', () => {
  assert.deepEqual(D.dcIdClean(' ' + ID + ' '), {ok:true, value:ID});
  assert.deepEqual(D.dcIdClean('<@' + ID + '>'), {ok:true, value:ID});
  assert.deepEqual(D.dcIdClean('<@!' + ID + '>'), {ok:true, value:ID});
  assert.deepEqual(D.dcIdClean('@' + ID), {ok:true, value:ID});
  for (const bad of ['', '1234', 'alice', '12345678901234567890123456', '1234567890123456x']) {
    const r = D.dcIdClean(bad);
    assert.equal(r.ok, false, bad);
  }
  assert.match(D.dcIdClean('alice').error, /Developer Mode/);
  assert.match(D.dcIdClean('alice').error, /Copy User ID/);
});

test('the effective block: a v51 scalar ownerUserId is the first owner; junk is the default', () => {
  assert.deepEqual(D.dcReadBlock({enabled:true, ownerUserIds:[ID, ID, 'nope', 7]}), {enabled:true, ownerUserIds:[ID]});
  assert.deepEqual(D.dcReadBlock({ownerUserId:ID}), {enabled:false, ownerUserIds:[ID]});
  assert.deepEqual(D.dcReadBlock({ownerUserIds:[], ownerUserId:ID}), {enabled:false, ownerUserIds:[]}, 'the list wins, as in parseDiscordOwnerUserIds');
  for (const junk of [null, undefined, 'x', [], {enabled:'yes'}]) assert.deepEqual(D.dcReadBlock(junk), {enabled:false, ownerUserIds:[]});
});

test('the status line: token, then an owner, then on, then the restart', () => {
  const st = D.dcInitial();
  st.hasToken = false;
  assert.equal(D.dcStatus(st, false).on, false);
  st.hasToken = true;
  assert.match(D.dcStatus(st, false).line, /add your Discord user id/);
  st.cfg = {enabled:false, ownerUserIds:[ID]};
  assert.match(D.dcStatus(st, false).line, /Turned off/);
  st.cfg.enabled = true;
  assert.match(D.dcStatus(st, true).line, /Waiting for a restart/);
  const on = D.dcStatus(st, false);
  assert.equal(on.on, true);
  assert.match(on.line, /direct message|@mention/);
});

test('saving a token writes DISCORD_BOT_TOKEN, owes a restart, and keeps the token out of state', async () => {
  const {api, calls} = fakeApi();
  const dc = D.createDiscordSettings(api);
  await dc.entered();
  assert.equal(dc.state.hasToken, false);
  dc.openToken();
  const bad = await dc.saveToken('short');
  assert.equal(bad.ok, false);
  assert.equal(dc.state.mode, 'tokenPrompt');
  assert.ok(!calls.some((c) => c[0] === 'setToken'), 'nothing written for a bad token');
  const ok = await dc.saveToken(TOKEN);
  assert.equal(ok.ok, true);
  assert.equal(dc.state.mode, 'list');
  assert.equal(dc.state.hasToken, true);
  assert.equal(dc.state.message, 'Token saved.');
  assert.ok(dc.restartOwed());
  assert.ok(!JSON.stringify(dc.state).includes(TOKEN), 'the token is never in state');
  assert.ok(!calls.some((c) => c[0] === 'write'), 'no owner yet: Discord stays off (an unpaired bot refuses everything)');
});

test('the first owner with a token turns Discord on in the same write; removing the last says the bot ignores everyone', async () => {
  const {api, calls, s} = fakeApi({token:TOKEN});
  const dc = D.createDiscordSettings(api);
  await dc.entered();
  dc.setDraftId('<@' + ID + '>');
  const added = await dc.addOwner();
  assert.equal(added.ok, true);
  assert.deepEqual(calls.find((c) => c[0] === 'write')[1], [['discord.ownerUserIds', [ID]], ['discord.enabled', true]]);
  assert.deepEqual(s.cfg, {enabled:true, ownerUserIds:[ID]});
  assert.equal(dc.state.draftId, '', 'the field empties after a save');
  assert.equal(dc.state.message, 'Owner added. Discord turned on.');
  const dup = await dc.addOwner(ID);
  assert.equal(dup.ok, false);
  assert.match(dc.state.idError, /already on the list/);
  await dc.addOwner(ID2);
  assert.deepEqual(s.cfg.ownerUserIds, [ID, ID2]);
  await dc.removeOwner(ID);
  assert.deepEqual(s.cfg.ownerUserIds, [ID2]);
  await dc.removeOwner(ID2);
  assert.deepEqual(s.cfg.ownerUserIds, []);
  assert.match(dc.state.message, /ignores every message/);
  assert.equal((await dc.removeOwner('999999999999999999')).ok, false, 'an id not on the list is not written');
});

test('a token saved after the owner turns Discord on, as the Telegram tab does after its token', async () => {
  const {api, s} = fakeApi({cfg:{enabled:false, ownerUserIds:[ID]}});
  const dc = D.createDiscordSettings(api);
  await dc.entered();
  await dc.saveToken(TOKEN);
  assert.equal(s.cfg.enabled, true);
  assert.equal(dc.state.message, 'Token saved and Discord turned on.');
});

test('a failed write says so and changes nothing; a bad id is not written', async () => {
  const {api, calls, s} = fakeApi({token:TOKEN, fail:{write:true}});
  const dc = D.createDiscordSettings(api);
  await dc.entered();
  await dc.addOwner('alice');
  assert.match(dc.state.idError, /15 to 25 digits/);
  assert.ok(!calls.some((c) => c[0] === 'write'));
  await dc.addOwner(ID);
  assert.equal(dc.state.lastError, 'Could not save the owners.');
  assert.equal(dc.state.lastErrorDetail, 'config locked', 'ATO-2745: the raw answer goes behind Details');
  assert.match(D.discordPaneHTML(dc.state, {}, h), /<details class="set-errmore"><summary>Details<\/summary><span>config locked<\/span><\/details>/);
  assert.deepEqual(s.cfg.ownerUserIds, []);
  await dc.setEnabled(true);
  assert.equal(dc.state.lastError, 'Could not turn Discord on.');
});

test('turning off, removing the token, and a second click that is not a double-click', async () => {
  const {api, s} = fakeApi({token:TOKEN, cfg:{enabled:true, ownerUserIds:[ID]}});
  const dc = D.createDiscordSettings(api);
  await dc.entered();
  await dc.setEnabled(false);
  assert.equal(s.cfg.enabled, false);
  assert.equal(dc.arm('clearToken', 1000), false, 'the first click arms');
  assert.equal(dc.arm('clearToken', 1200), false, 'a double-click does not confirm');
  assert.equal(dc.arm('clearToken', 2000), true, 'a later second click confirms');
  await dc.clearToken();
  assert.equal(s.token, null);
  assert.equal(dc.state.hasToken, false);
});

test('the restart: refused while a reply runs, then the result says what is still missing', async () => {
  const f = fakeApi({token:TOKEN});
  const dc = D.createDiscordSettings(f.api);
  await dc.entered();
  f.s.blocked = true;
  await dc.restart();
  assert.equal(dc.state.restart.phase, 'failed');
  assert.match(dc.state.restart.text, /reply is still running/);
  assert.ok(!f.calls.some((c) => c[0] === 'restart'));
  f.s.blocked = false;
  await dc.restart();
  assert.equal(dc.state.restart.phase, 'done');
  assert.match(dc.state.restart.text, /Add your Discord user id/);
  assert.deepEqual(D.dcRestartResult({state:'error', error:'port busy.'}, {}), {phase:'failed', text:'The agent did not start again. Press Restart agent to try again.', detail:'port busy.'});
  assert.match(D.dcRestartResult({state:'connected'}, {hasToken:true, ownerUserIds:[ID], enabled:true}).text, /bot is connected/);
});

test('the pane: Connect card first, then status, owners, the rows, and the restart owed', async () => {
  const f = fakeApi();
  const dc = D.createDiscordSettings(f.api);
  assert.match(D.discordPaneHTML(dc.state, {}, h), /Loading/);
  await dc.entered();
  let html = D.discordPaneHTML(dc.state, {}, h);
  assert.ok(html.includes('data-dc-connect') && html.includes('data-act="discord:token"') && html.includes('data-act="discord:portal"'));
  dc.openToken();
  html = D.discordPaneHTML(dc.state, {}, h);
  assert.ok(html.includes('id="dc-token" type="password"'));
  await dc.saveToken(TOKEN);
  html = D.discordPaneHTML(dc.state, {owed:dc.restartOwed()}, h);
  assert.ok(html.includes('data-dc-status="not-connected"'));
  assert.ok(html.includes('id="dc-owner"') && html.includes('data-act="discord:addOwner"'));
  assert.ok(html.includes('data-act="discord:enable"') && html.includes('data-act="discord:clearToken"'));
  assert.ok(html.includes('data-act="discord:restart"'));
  assert.ok(html.includes(D.DC_RESTART_APPLY));
  assert.ok(!html.includes(TOKEN));
  await dc.addOwner(ID);
  html = D.discordPaneHTML(dc.state, {owed:false}, h);
  assert.ok(html.includes('data-dc-owner="' + ID + '"') && html.includes('data-act="discord:removeOwner:' + ID + '"'));
  assert.ok(html.includes('data-dc-status="connected"'));
  dc.arm('removeOwner:' + ID, 0);
  assert.ok(D.discordPaneHTML(dc.state, {}, h).includes('Click again to remove'));
  for (const part of [html, D.dcIdClean('x').error, D.dcStatus(dc.state, true).line, D.DC_RESTART_APPLY]) assert.ok(!part.includes('—'));
});

test('renderer wiring: the helper loads before renderer.js; the pane, verbs, keys and the token key are wired', () => {
  const helper = index.indexOf('<script src="discord-settings.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  assert.match(source, /\['connections','Connections','plug',\['mcp','telegram','discord','push','composio','monid'\]\]/);   // with Phone push (ATO-1129)
  assert.ok(source.includes("['discord','Discord']"));
  assert.ok(source.includes("['chat','Discord','Settings · Connections','','settings:discord']"));
  for (const hook of ["pane === 'discord') discordTabEntered()", "p === 'discord') return discordTab()",
    "k === 'discord') { close(); discordAct(a.slice(8))", "pane === 'discord' && discordKey(e, k, inText)",
    "e.target.id === 'dc-owner') { DC.setDraftId(e.target.value)"]) {
    assert.ok(source.includes(hook), hook);
  }
  assert.ok(source.includes("BR.dotenvSet(stateDir, DISCORD_TOKEN_ENV, v)"));
  assert.ok(source.includes("BR.configGetKey('discord')"));
  assert.equal(D.DISCORD_TOKEN_ENV, 'DISCORD_BOT_TOKEN');
});

// ATO-516: the bot's live state, from the agent's GET /api/discord/channel.
test('live status: connected as the bot, connecting, a failure in words, another agent holding the bot', async () => {
  const f = fakeApi({cfg:{enabled:true, ownerUserIds:[ID]}, token:TOKEN});
  let live = {available:true, state:'up', lastError:null, hasToken:true, bot:{id:'1', username:'atomic_bot'}, otherPoller:null};
  f.api.channel = async () => live;
  const dc = D.createDiscordSettings(f.api);
  await dc.entered();
  let s = D.dcStatus(dc.state, false);
  assert.equal(s.chip, 'connected');
  assert.match(s.line, /^Connected as @atomic_bot\. /);
  live = Object.assign({}, live, {state:'starting'});
  assert.equal(await dc.pollChannel(), true, 'a change asks for a repaint');
  assert.equal(await dc.pollChannel(), false, 'the same answer does not');
  assert.equal(D.dcStatus(dc.state, false).chip, 'connecting');
  assert.ok(D.discordPaneHTML(dc.state, {}, h).includes('data-dc-status="connecting"'));
  live = Object.assign({}, live, {state:'down', lastError:'Discord gateway closed (4004: Authentication failed).'});
  await dc.pollChannel();
  s = D.dcStatus(dc.state, false);
  assert.equal(s.chip, 'not-connected');
  // ATO-2745: the library's own words are the Details, not the line.
  assert.equal(s.line, 'The bot could not connect to Discord. Check the token, then press Restart agent below.');
  assert.equal(s.detail, 'Discord gateway closed (4004: Authentication failed).');
  assert.ok(!s.line.includes('4004'));
  live = Object.assign({}, live, {otherPoller:{where:'this_computer', pid:4242}});
  await dc.pollChannel();
  const other = D.dcStatus(dc.state, false);
  assert.match(other.line, /^Another Atomic Agent on this computer is running this bot/);
  assert.ok(!other.line.includes('4242'), 'ATO-2745: no process id in the line');
  assert.equal(other.detail, 'Process id: 4242');
  assert.match(D.discordPaneHTML(dc.state, {}, h), /<summary>Details<\/summary><span>Process id: 4242<\/span>/);
  live = Object.assign({}, live, {state:'disabled', otherPoller:null, lastError:null});
  await dc.pollChannel();
  assert.match(D.dcStatus(dc.state, false).line, /has not started the bot/);
  // A restart owed still says so first, whatever the agent reports.
  assert.match(D.dcStatus(dc.state, true).line, /Waiting for a restart/);
  for (const line of [s.line, D.dcStatus(dc.state, false).line]) assert.ok(!line.includes('—'));
});

test('live status: an agent without the route keeps the saved-settings wording', async () => {
  const f = fakeApi({cfg:{enabled:true, ownerUserIds:[ID]}, token:TOKEN});
  f.api.channel = async () => null;
  const dc = D.createDiscordSettings(f.api);
  await dc.entered();
  const s = D.dcStatus(dc.state, false);
  assert.equal(s.chip, 'connected');
  assert.match(s.line, /^Send your bot a direct message/);
  f.api.channel = async () => { throw new Error('ipc gone'); };
  await dc.pollChannel();
  assert.equal(dc.state.channel, null);
});

test('live loop: polls while the tab is visible, repaints on change, one loop at a time', async () => {
  const f = fakeApi({cfg:{enabled:true, ownerUserIds:[ID]}, token:TOKEN});
  let n = 0;
  f.api.channel = async () => ({available:true, state:n++ % 2 ? 'up' : 'starting', lastError:null, bot:null, otherPoller:null});
  const dc = D.createDiscordSettings(f.api);
  const queued = [];
  const timers = {setTimeout: (fn, ms) => { assert.equal(ms, D.DC_LIVE_POLL_MS); queued.push(fn); }};
  let visible = true, paints = 0;
  D.dcLiveLoop(dc, () => visible, () => { paints++; }, timers);
  D.dcLiveLoop(dc, () => visible, () => { paints++; }, timers);
  // Each poll is two awaits deep; let the microtasks run.
  const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  await settle();
  assert.equal(queued.length, 1, 'the second call did not start a second loop');
  queued.shift()(); await settle();
  assert.equal(paints, 2);
  visible = false;
  queued.shift()(); await settle();
  assert.equal(queued.length, 0, 'a hidden tab stops the loop');
  assert.equal(dc.state.liveLoop, false);
});

test('renderer wiring (ATO-516): the live call reaches the agent and the tab starts the loop', () => {
  assert.ok(source.includes("channel: () => BR && BR.discordChannel ? BR.discordChannel() : null"));
  assert.ok(source.includes('dcLiveLoop(DC, discordVisible, dcRepaint)'));
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  assert.ok(preload.includes('discordChannel: () => ipcRenderer.invoke("agent:discordChannel")'));
  const live = readFileSync(new URL('../main/agent-live.ts', import.meta.url), 'utf8');
  assert.ok(live.includes('ipcMain.handle("agent:discordChannel", () => client.discordChannel())'));
  const client = readFileSync(new URL('../main/agent-client.ts', import.meta.url), 'utf8');
  assert.ok(client.includes('/api/discord/channel'));
});

// ATO-2745: the token line says where the token really went, and a failed save keeps the raw answer behind Details.
test('token save: keychain or private file as main answers; a failure is a plain line plus Details', async () => {
  const {api} = fakeApi();
  api.setToken = async () => ({ok:true, storedIn:'keychain'});
  const dc = D.createDiscordSettings(api);
  await dc.entered();
  await dc.saveToken(TOKEN);
  assert.equal(dc.state.message, 'Token saved in your system keychain.');
  api.setToken = async () => ({ok:true, storedIn:'file', keychainFallback:true});
  await dc.saveToken(TOKEN);
  assert.equal(dc.state.message, 'Token saved in a private file because the system keychain was not available.');
  api.setToken = async () => ({ok:false, error:'The key could not be saved in the system keychain.', detail:'keychain locked'});
  dc.openToken();
  await dc.saveToken(TOKEN);
  assert.equal(dc.state.tokenError, 'Could not save the token.');
  const html = D.discordPaneHTML(dc.state, {}, h);
  assert.match(html, /<summary>Details<\/summary><span>The key could not be saved in the system keychain\.\nkeychain locked<\/span>/);
  assert.ok(!html.includes('a file only your user account can read'), 'the prompt no longer claims a file before the save');
});
