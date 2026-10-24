// Settings › Connections › Telegram, Restart agent (ATO-900 item 6): every line
// that asks for a restart has a primary button beside it, says the app stays
// open, and shows the restart's result in place. The helpers come from
// renderer/telegram-restart.js; renderer.js and index.html are read as text for
// the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../renderer/telegram-restart.js');
const P = require('../renderer/telegram-pairing.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (name) => '<svg data-ic="' + name + '"></svg>'};
const ready = {hasToken:true, owner:4242, enabled:true};

test('the button is primary, restarts from the Telegram tab, and is disabled with "Restarting…" while it runs', () => {
  const idle = R.tgRestartButtonHTML(R.tgRestartInitial(), h);
  assert.match(idle, /class="btn btn-p sm" data-act="telegram:restart"/);
  assert.ok(idle.includes('>Restart agent<') || idle.endsWith('Restart agent</button>'));
  assert.ok(!idle.includes('disabled'));
  const busy = R.tgRestartButtonHTML(R.tgRestartStart(), h);
  assert.ok(busy.includes(' disabled') && busy.includes('Restarting…'));
});

test('the words say the app stays open, and none has an em dash', () => {
  assert.ok(R.TG_RESTART_APPLY.includes('The app stays open.'));
  assert.ok(R.TG_RESTARTING.includes('The app stays open.'));
  assert.ok(P.TG_PAIR_NOT_RUNNING.includes('The app stays open.'));
  for (const s of [R.TG_RESTART_APPLY, R.TG_RESTARTING, R.TG_RESTART_BUSY, P.TG_PAIR_NOT_RUNNING]) assert.ok(!s.includes('—'), s);
  for (const st of [null, {state:'error', error:'boom'}, {state:'connected'}]) {
    for (const v of [ready, {hasToken:true, owner:null, enabled:true}, {hasToken:true, owner:1, enabled:false}, {hasToken:false, owner:null, enabled:null}]) {
      assert.ok(!R.tgRestartResult(st, v).text.includes('—'));
    }
  }
});

test('a restart that comes back connected says what is true now', () => {
  const ok = {state:'connected', workingDir:'/w'};
  assert.equal(R.tgRestartResult(ok, ready).phase, 'done');
  assert.match(R.tgRestartResult(ok, ready).text, /^The agent restarted and the bot is connected\./);
  assert.match(R.tgRestartResult(ok, {hasToken:true, owner:null, enabled:true}).text, /Press Pair/);
  assert.match(R.tgRestartResult(ok, {hasToken:true, owner:4242, enabled:false}).text, /Turn on Answer in Telegram/);
  assert.equal(R.tgRestartResult(ok, {hasToken:false, owner:null, enabled:null}).text, 'The agent restarted.');
});

test('a restart that does not come back says why and offers the button again', () => {
  const failed = R.tgRestartResult({state:'error', error:'spawn atag ENOENT.'}, ready);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.text, 'The agent did not start again: spawn atag ENOENT. Press Restart agent to try again.');
  assert.match(R.tgRestartResult(null, ready).text, /no reason given/);
  assert.match(R.tgRestartResult({state:'missing-binary'}, ready).text, /no reason given/);
  const html = R.tgRestartNoticeHTML(failed, h);
  assert.ok(html.includes('tk-notice--red') && html.includes('data-act="telegram:restart"'));
  assert.ok(R.tgRestartSpeaks(failed));
});

test('the restart\'s own line: nothing at rest, a spinner while it runs, green when done; refused while a reply runs', () => {
  assert.equal(R.tgRestartNoticeHTML(R.tgRestartInitial(), h), '');
  const running = R.tgRestartNoticeHTML(R.tgRestartStart(), h);
  assert.ok(running.includes('tk-notice--blue') && running.includes('tk-spin') && running.includes(esc(R.TG_RESTARTING)));
  assert.ok(!running.includes('data-act="telegram:restart"'));
  assert.ok(R.tgRestartSpeaks(R.tgRestartStart()));
  const done = R.tgRestartResult({state:'connected'}, ready);
  assert.ok(R.tgRestartNoticeHTML(done, h).includes('tk-notice--green'));
  assert.ok(!R.tgRestartSpeaks(done) && !R.tgRestartSpeaks(R.tgRestartInitial()));
  const refused = R.tgRestartRefused();
  assert.equal(refused.phase, 'failed');
  assert.equal(refused.text, R.TG_RESTART_BUSY);
});

test('the pairing card puts Restart agent beside Pair when the agent says Telegram is not running', () => {
  const ctx = {howto:'HOWTO', note:'NOTE', busy:false, label:'Pair', restart:R.tgRestartButtonHTML(R.tgRestartInitial(), h)};
  const down = P.tgPairApply(P.tgPairInitial(), 'start', {ok:false, code:'telegram_not_running', error:'Telegram is not running (state: down).'}, 1);
  const html = P.tgPairCardHTML(down, ctx, h);
  assert.ok(html.includes(esc(P.TG_PAIR_NOT_RUNNING)));
  assert.ok(html.includes('data-act="telegram:restart"') && html.includes('data-act="telegram:pairStart"'));
  // Restart is the step to take first: it is the primary, and Pair steps down to secondary.
  assert.match(html, /class="btn btn-s sm" data-act="telegram:pairStart"/);
  // Any other error keeps the plain card.
  const other = P.tgPairApply(P.tgPairInitial(), 'start', {ok:false, error:'HTTP 500'}, 1);
  assert.ok(!P.tgPairCardHTML(other, ctx, h).includes('telegram:restart'));
});

test('renderer wiring: the helper loads before renderer.js; every restart line in the tab uses it; the trigger is telegram', () => {
  const helper = index.indexOf('<script src="telegram-restart.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  assert.ok(source.includes("if (verb === 'restart') { tgRestart(); return; }"));
  assert.ok(source.includes("await BR.restart('telegram')"));
  // The old tertiary "Restart Agent Runtime" and "It takes effect after a restart." are gone from the tab.
  const tab = source.slice(source.indexOf('function telegramTab()'), source.indexOf('function tgTokenPromptHTML()'));
  assert.ok(!tab.includes('Restart Agent Runtime') && !tab.includes('takes effect after a restart'));
  assert.ok(tab.includes('tgRestartButtonHTML(TG.restart, {esc, ic})') && tab.includes('tgRestartNoticeHTML(TG.restart, {esc, ic})'));
  assert.equal((source.match(/restart:tgRestartButtonHTML\(TG\.restart, \{esc, ic\}\)/g) || []).length, 2, 'both pairing cards get the button');
  // A running reply would end with the restart: refused in place.
  assert.match(source, /async function tgRestart\(\) \{[\s\S]*?if \(restartStopsTurn\(\)\) \{ TG\.restart = tgRestartRefused\(\)/);
  // A failed read of the tab after the restart still says the result: left at
  // 'restarting', the button would stay disabled with nothing to clear it.
  const body = source.slice(source.indexOf('async function tgRestart() {'), source.indexOf('\n}\n', source.indexOf('async function tgRestart() {')));
  assert.match(body, /try \{[\s\S]*?await tgRefresh\(\);[\s\S]*?\} catch \(e\) \{[^}]*\}\n  TG\.restart = tgRestartResult\(/);
});
