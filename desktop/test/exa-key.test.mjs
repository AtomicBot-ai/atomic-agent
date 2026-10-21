// ATO-328: the Exa key card under a web search call that asked for a key,
// and the same field in Settings › General. Renderer side: what is read off a
// `tool_result` frame (`key_required`), which call the one card goes under, the
// markup, and the save. The helpers come from renderer/exa-key.js; the
// renderer.js functions that wire them in are lifted out of its source and run
// in a vm context, the way switching-outbox.test.mjs does. The key here is a
// dummy and nothing is written anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const X = require('../renderer/exa-key.js');
const ts = require('typescript');
const exaSource = readFileSync(new URL('../renderer/exa-key.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));

const KEY = 'exa-dummy-0123456789abcdef';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (n) => '<i:' + n + '>'};
const asked = (reason = 'rate_limited') => ({provider:'exa', reason, getKeyUrl:'https://dashboard.exa.ai/api-keys', envVar:'EXA_API_KEY'});

/* ---------------- reading the result ---------------- */

// A tool_result frame as POST /v1/chat/completions sends it (ATO-197), with the agent's ATO-327 field.
const frame = (over = {}) => Object.assign({id:'cmpl-1', object:'chat.completion.tool_result', created:1, model:'m', session_id:'s',
  call_id:'3:0', tool:'os.web.search', status:'error', duration_ms:900, summary:'rate limited'}, over);

test('key_required is read off the tool_result frame, with status error or ok, and nothing else turns the card on', () => {
  assert.deepEqual(X.exaKeyRequired(frame({key_required:asked()})),
    {reason:'rate_limited', getKeyUrl:'https://dashboard.exa.ai/api-keys'});
  // Exa parked, DuckDuckGo answered: the search succeeded and the card still comes.
  assert.equal(X.exaKeyRequired(frame({status:'ok', summary:'8 results', key_required:asked('unreachable')})).reason, 'unreachable');
  assert.equal(X.exaKeyRequired(frame()), null, 'an agent without the field: nothing changes');
  assert.equal(X.exaKeyRequired(frame({status:'ok', summary:'8 results'})), null);
  assert.equal(X.exaKeyRequired(frame({key_required:{provider:'brave', reason:'missing'}})), null);
  assert.equal(X.exaKeyRequired(frame({key_required:'yes'})), null);
  assert.equal(X.exaKeyRequired(frame({key_required:null})), null);
  assert.equal(X.exaKeyRequired(frame({details:{keyRequired:asked()}})), null, 'only the frame field counts');
  assert.equal(X.exaKeyRequired(null), null);
  assert.equal(X.exaKeyRequired(undefined), null);
  assert.equal(X.exaKeyRequired(frame({key_required:{provider:'exa', reason:'something new'}})).reason, 'missing');
});

test('the key page opened in the browser is an https page on exa.ai, or ours', () => {
  assert.equal(X.exaKeyUrl('https://dashboard.exa.ai/api-keys'), 'https://dashboard.exa.ai/api-keys');
  assert.equal(X.exaKeyUrl('https://exa.ai/'), 'https://exa.ai/');
  for (const bad of ['http://dashboard.exa.ai/api-keys', 'https://exa.ai.evil.example/', 'https://evilexa.ai/', 'javascript:alert(1)', '', null, 42]) {
    assert.equal(X.exaKeyUrl(bad), X.EXA_KEY_URL, String(bad));
  }
});

test('one card per conversation: under the newest call that asked', () => {
  const log = [
    {id:'u1', k:'user'}, {id:'t1', k:'tool', keyReq:{reason:'missing'}}, {id:'t2', k:'tool', keyReq:{reason:'missing'}},
    {id:'u2', k:'user'}, {id:'t3', k:'tool', keyReq:{reason:'rate_limited'}}, {id:'t4', k:'tool'}, {id:'a', k:'assistant'},
  ];
  assert.equal(X.exaKeyHost(log), 't3');
  assert.equal(X.exaKeyHost([{id:'t', k:'tool'}, {id:'r', k:'assistant'}]), null);
  assert.equal(X.exaKeyHost(null), null);
});

test('a pasted key is trimmed; empty is "keep the saved key"; spaces, line breaks and scraps are refused', () => {
  assert.equal(X.exaKeyClean('  ' + KEY + '\n'), KEY);
  assert.equal(X.exaKeyClean(''), '');
  assert.equal(X.exaKeyClean('   '), '');
  assert.equal(X.exaKeyClean(undefined), '');
  assert.equal(X.exaKeyClean('abc'), null);
  assert.equal(X.exaKeyClean('exa key with spaces'), null);
  assert.equal(X.exaKeyClean(KEY + '\nOTHER_VAR=1'), null);
  assert.equal(X.exaKeyClean('k'.repeat(257)), null);
});

/* ---------------- the markup ---------------- */

test('the card asks in plain words, with the key page, a password field and Save', () => {
  for (const reason of Object.keys(X.EXA_KEY_REASONS)) {
    const html = X.exaKeyCardHTML({reason, getKeyUrl:X.EXA_KEY_URL}, {has:false}, h);
    assert.match(html, /Web search needs an Exa key/);
    assert.ok(html.includes(esc(X.EXA_KEY_REASONS[reason])), reason);
    assert.match(html, /<input type="password" data-exa-key="chat"/);
    assert.match(html, /placeholder="Paste your Exa API key"/);
    assert.match(html, /data-url="https:\/\/dashboard\.exa\.ai\/api-keys">[^<]*<i:globe>Get a free Exa key<\/button>/);
    assert.match(html, /data-act="exakey:save:chat"[^>]*>Save</);
    assert.doesNotMatch(html, /value=/, 'the field is emitted empty');
    assert.doesNotMatch(html, /\u2014/, 'no em dash in UI text');
  }
  assert.match(X.exaKeyCardHTML({reason:'missing', getKeyUrl:X.EXA_KEY_URL}, {has:true}, h), /A key is already saved/);
  const err = X.exaKeyCardHTML({reason:'missing', getKeyUrl:X.EXA_KEY_URL}, {error:'Paste the key first.'}, h);
  assert.match(err, /is-error/); assert.match(err, /tk-help--err">Paste the key first\./);
  assert.match(X.exaKeyCardHTML({reason:'missing', getKeyUrl:X.EXA_KEY_URL}, {saving:true}, h), /data-exa-key="chat"[^>]* disabled/);
});

test('saved: the card says so, and offers the restart only while it is owed and no reply runs', () => {
  const req = {reason:'rate_limited', getKeyUrl:X.EXA_KEY_URL};
  const owed = X.exaKeyCardHTML(req, {saved:true, restartOwed:true, busy:false}, h);
  assert.match(owed, /Exa key saved/); assert.match(owed, /once the agent restarts/);
  assert.match(owed, /data-act="agent:restart"/); assert.doesNotMatch(owed, /data-exa-key/);
  const busy = X.exaKeyCardHTML(req, {saved:true, restartOwed:true, busy:true}, h);
  assert.doesNotMatch(busy, /data-act="agent:restart"/); assert.match(busy, /when the running reply is done/);
  const done = X.exaKeyCardHTML(req, {saved:true, restartOwed:false}, h);
  assert.match(done, /Web search uses it now/); assert.doesNotMatch(done, /agent:restart/);
});

test('Settings row: the same field, whether a key is saved, and the key page', () => {
  const row = X.exaKeySettingsRowHTML({has:true}, h);
  assert.match(row, /Web search key \(Exa\)/); assert.match(row, /A key is saved\./);
  assert.match(row, /<input type="password" data-exa-key="settings"/);
  assert.match(row, /class="set-link" data-url="https:\/\/dashboard\.exa\.ai\/api-keys">Get a free Exa key/);
  assert.match(row, /data-act="exakey:save:settings"/);
  assert.match(X.exaKeySettingsRowHTML({has:false}, h), /No key saved\./);
  assert.doesNotMatch(X.exaKeySettingsRowHTML({has:null}, h), /key saved\.|No key saved/i);
  assert.match(X.exaKeySettingsRowHTML({has:true, note:'Nothing pasted, so the saved key stays.'}, h), /saved key stays/);
});

/* ---------------- renderer.js wiring ---------------- */

function fixture(over = {}) {
  let id = 0;
  const calls = [];
  const c = vm.createContext(Object.assign({
    S:{log:[], busy:false, settings:null, overlay:null},
    RUNNING:new Map(), AGENT_GEN:3, OPEN_GROUPS:new Set(),
    EXA:{has:null, checking:false, saving:false, savedGen:null, savedFor:null,
      draft:{chat:'', settings:''}, error:{chat:null, settings:null}, note:{chat:null, settings:null}},
    BR:{dotenvSet:async (...a) => { calls.push(a); return {ok:true, path:'/state/.env', preexisting:false, changed:true}; }},
    memStateDir:() => '/state', render(){}, setTimeout(){}, document:{querySelector:() => null, querySelectorAll:() => []},
    esc, ic:h.ic, nid:() => 'n' + (++id), summariseArgs:() => '', reasonStepAt:() => 1, CATEGORY_LABEL:{},
    item:(m) => '<row ' + m.id + '>', groupCard:(run) => '<group ' + run.map((m) => m.id).join(',') + '>',
    systemRun:() => '', exaKeyRefresh(){}, URL,
  }, over));
  vm.runInContext(exaSource, c);
  for (const name of ['sessionTurnsToLog', 'renderItems', 'exaKeyBusy', 'exaKeyState', 'exaKeyTurnHTML', 'exaKeySave', 'exaKeyAct', 'toolSettle']) {
    assert.ok(functions.has(name), name);
    vm.runInContext(functions.get(name), c);
  }
  return {c, calls};
}

test('a reopened chat draws no card: the store does not keep the field', () => {
  const {c} = fixture();
  const log = c.sessionTurnsToLog([
    {kind:'user', text:'news about llama.cpp'},
    {kind:'assistant_tool_call', tool:'os.web.search', args:{query:'llama.cpp'}, at:1},
    {kind:'tool_result', tool:'os.web.search', status:'error', summary:'rate limited', at:2},
  ]);
  assert.equal(log.filter((m) => m.keyReq).length, 0);
  c.S.log = log;
  assert.equal(c.renderItems().includes('data-exa-card'), false);
});

test('the live tool_result frame puts the card on its call; a frame without the field changes nothing', () => {
  const {c} = fixture();
  const card = {k:'tool', name:'os.web.search', ok:null};
  c.toolSettle(card, frame({key_required:asked()}), 1000);
  assert.equal(card.keyReq.reason, 'rate_limited');
  assert.equal(card.ok, false);
  const served = {k:'tool', name:'os.web.search', ok:null};
  c.toolSettle(served, frame({status:'ok', summary:'8 results', key_required:asked()}), 1000);
  assert.equal(served.ok, true, 'a search that succeeded stays a success');
  assert.equal(served.keyReq.reason, 'rate_limited');
  const plain = {k:'tool', name:'os.web.search', ok:null};
  c.toolSettle(plain, frame({status:'ok', summary:'8 results'}), 1000);
  assert.equal('keyReq' in plain, false);
  assert.equal(plain.ok, true);
});

test('the transcript draws one card, under the newest call that asked, and below the fold that holds it', () => {
  const {c} = fixture();
  const kr = {reason:'missing', getKeyUrl:X.EXA_KEY_URL};
  c.S.log = [{id:'u1', k:'user'}, {id:'t1', k:'tool', name:'os.web.search', keyReq:kr}, {id:'a1', k:'assistant'},
    {id:'u2', k:'user'}, {id:'t2', k:'tool', name:'os.web.search', keyReq:kr}, {id:'a2', k:'assistant'}];
  const html = c.renderItems();
  assert.equal((html.match(/data-exa-card=/g) || []).length, 1);
  assert.ok(html.indexOf('<row t2>') < html.indexOf('id="exak-t2"') && html.indexOf('id="exak-t2"') < html.indexOf('<row a2>'));
  // Three searches in a row fold into one line; the card goes under the fold.
  c.S.log = [{id:'u', k:'user'}, {id:'s1', k:'tool', name:'os.web.search'}, {id:'s2', k:'tool', name:'os.web.search', keyReq:kr},
    {id:'s3', k:'tool', name:'os.web.search'}, {id:'r', k:'assistant'}];
  const folded = c.renderItems();
  assert.match(folded, /^<row u><group s1,s2,s3><div class="turn tk-step exak-turn" id="exak-s2">/);
  // Nothing asked: no card, and the transcript is what it was.
  c.S.log = [{id:'u', k:'user'}, {id:'t', k:'tool', name:'os.web.search'}, {id:'r', k:'assistant'}];
  assert.equal(c.renderItems(), '<row u><row t><row r>');
});

test('what is being typed never reaches the markup', () => {
  const {c} = fixture();
  c.EXA.draft.chat = KEY; c.EXA.draft.settings = KEY;
  c.S.log = [{id:'t', k:'tool', name:'os.web.search', keyReq:{reason:'missing', getKeyUrl:X.EXA_KEY_URL}}];
  assert.equal(c.renderItems().includes(KEY), false);
  assert.equal(X.exaKeySettingsRowHTML(c.exaKeyState('settings'), h).includes(KEY), false);
});

test('Save writes EXA_API_KEY through app:dotenvSet, clears the draft, and owes a restart', async () => {
  const {c, calls} = fixture();
  c.S.log = [{id:'t', k:'tool', name:'os.web.search', keyReq:{reason:'rate_limited', getKeyUrl:X.EXA_KEY_URL}}];
  c.EXA.draft.chat = '  ' + KEY + ' ';
  await c.exaKeySave('chat');
  assert.deepEqual(calls, [['/state', 'EXA_API_KEY', KEY]]);
  assert.equal(c.EXA.draft.chat, '');
  assert.equal(c.EXA.has, true);
  assert.equal(c.EXA.savedFor, 't');
  assert.equal(c.exaKeyState('chat').restartOwed, true);
  assert.match(c.exaKeyTurnHTML(c.S.log[0]), /Exa key saved[\s\S]*agent:restart/);
  assert.match(c.exaKeyState('settings').note, /after the agent restarts/);
  // The agent keeps sending the field until it restarts; the card moves to the newer search and still says saved.
  c.S.log.push({id:'t9', k:'tool', name:'os.web.search', keyReq:{reason:'rate_limited', getKeyUrl:X.EXA_KEY_URL}});
  assert.match(c.renderItems(), /id="exak-t9"[\s\S]*Exa key saved/);
  assert.equal((c.renderItems().match(/data-exa-card=/g) || []).length, 1);
  // A new agent is up: nothing owed any more.
  c.AGENT_GEN = 4;
  assert.equal(c.exaKeyState('chat').restartOwed, false);
  assert.match(c.exaKeyTurnHTML(c.S.log[0]), /Web search uses it now/);
  // Still asked after that restart (the key did not take): the newer card asks again, saying a key is there.
  assert.match(c.exaKeyTurnHTML(c.S.log[1]), /data-exa-card="ask"[\s\S]*A key is already saved/);
});

test('an empty Save keeps the saved key; with none saved it asks for one; a scrap is refused; nothing is written', async () => {
  const {c, calls} = fixture();
  c.EXA.has = true;
  await c.exaKeySave('settings');
  assert.equal(c.EXA.note.settings, 'Nothing pasted, so the saved key stays.');
  assert.equal(c.EXA.error.settings, null);
  c.EXA.has = false;
  await c.exaKeySave('settings');
  assert.equal(c.EXA.error.settings, 'Paste the key first.');
  c.EXA.draft.chat = 'not a key';
  await c.exaKeySave('chat');
  assert.match(c.EXA.error.chat, /does not look like an Exa API key/);
  await c.exaKeySave('elsewhere');
  assert.deepEqual(calls, []);
});

test('a refused write says so under the field and never quotes the key back', async () => {
  const {c} = fixture({BR:{dotenvSet:async () => ({ok:false, error:'EACCES: permission denied'})}});
  c.EXA.draft.settings = KEY;
  await c.exaKeySave('settings');
  assert.equal(c.EXA.error.settings, 'Could not save the key: EACCES: permission denied');
  assert.equal(c.EXA.draft.settings, KEY, 'the draft stays for another try');
  assert.equal(c.EXA.savedGen, null);
});
