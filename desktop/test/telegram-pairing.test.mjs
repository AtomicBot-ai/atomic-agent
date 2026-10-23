// Settings › Connections › Telegram, pairing from the app (ATO-859), renderer
// side: what each reply from the agent's /api/telegram/pairing does to the
// pairing state, and the card it draws. The helpers come from
// renderer/telegram-pairing.js; renderer.js and index.html are read as text
// for the copy and the wiring. Every code here is a dummy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../renderer/telegram-pairing.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc};
const ctx = {howto:'HOWTO', note:'NOTE', busy:false, label:'Pair'};
const NOW = 1_000_000;
const opened = {ok:true, data:{status:'waiting', code:'048213', expiresAt:NOW + 300_000, timeoutMs:300_000, botUsername:'atomic_test_bot',
  instruction:'Send /start 048213 to @atomic_test_bot in Telegram within 5 minutes. The code works once; other messages are ignored.'}};

test('a start opens the window with the code and the agent\'s instruction', () => {
  const p = P.tgPairApply(P.tgPairInitial(), 'start', opened, NOW);
  assert.equal(p.phase, 'waiting');
  assert.equal(p.supported, true);
  assert.equal(p.code, '048213');
  assert.equal(p.expiresAt, NOW + 300_000);
  assert.equal(p.botUsername, 'atomic_test_bot');
  assert.ok(P.tgPairPolling(p));
  const html = P.tgPairCardHTML(p, ctx, h);
  assert.match(html, /data-tg-code[^>]*>048213</);
  assert.ok(html.includes('Send /start 048213 to @atomic_test_bot'));
  assert.ok(html.includes('data-act="telegram:pairCancel"') && html.includes('data-act="telegram:pairStart"'));
});

test('a claim ends the window with "Paired: @username" and drops the code', () => {
  const waiting = P.tgPairApply(P.tgPairInitial(), 'start', opened, NOW);
  const p = P.tgPairApply(waiting, 'status', {ok:true, data:{status:'claimed', pairedLine:'Paired: @new_owner is now the owner.'}}, NOW + 1000);
  assert.equal(p.phase, 'paired');
  assert.equal(p.code, null);
  assert.equal(p.pairedLine, 'Paired: @new_owner is now the owner.');
  assert.equal(P.tgPairPolling(p), false);
  const html = P.tgPairCardHTML(p, ctx, h);
  assert.ok(html.includes('Paired: @new_owner is now the owner.'));
  assert.ok(!html.includes('048213'));
});

test('a claim from an earlier visit is not news: only the window this tab opened moves', () => {
  const p = P.tgPairApply(P.tgPairInitial(), 'status', {ok:true, data:{status:'claimed', pairedLine:'Paired: @old is now the owner.'}}, NOW);
  assert.equal(p.phase, 'idle');
  assert.equal(p.supported, true);
  assert.equal(p.pairedLine, null);
});

test('expired, cancelled, failed and an agent that restarted (idle) end the window', () => {
  const waiting = P.tgPairApply(P.tgPairInitial(), 'start', opened, NOW);
  const expired = P.tgPairApply(waiting, 'status', {ok:true, data:{status:'expired'}}, NOW);
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.code, null);
  assert.ok(P.tgPairCardHTML(expired, ctx, h).includes(P.TG_PAIR_EXPIRED));
  assert.equal(P.tgPairApply(waiting, 'status', {ok:true, data:{status:'idle'}}, NOW).phase, 'expired');
  assert.equal(P.tgPairApply(waiting, 'status', {ok:true, data:{status:'cancelled'}}, NOW).phase, 'idle');
  const failed = P.tgPairApply(waiting, 'status', {ok:true, data:{status:'failed', error:'could not write config'}}, NOW);
  assert.equal(failed.phase, 'idle');
  assert.equal(failed.error, 'Pairing failed: could not write config');
  assert.equal(P.tgPairApply(waiting, 'cancel', {ok:true, data:{status:'cancelled'}}, NOW).phase, 'idle');
});

test('a window past its expiry plus grace ends here even if the agent still says waiting', () => {
  const waiting = P.tgPairApply(P.tgPairInitial(), 'start', opened, NOW);
  const still = {ok:true, data:{status:'waiting'}};
  assert.equal(P.tgPairApply(waiting, 'status', still, NOW + 300_000).phase, 'waiting');
  assert.equal(P.tgPairApply(waiting, 'status', still, NOW + 300_000 + P.TG_PAIR_GRACE_MS + 1).phase, 'expired');
});

test('a failed poll changes nothing; the next one tries again', () => {
  const waiting = P.tgPairApply(P.tgPairInitial(), 'start', opened, NOW);
  const p = P.tgPairApply(waiting, 'status', {ok:false, error:'agent is not running'}, NOW);
  assert.equal(p.phase, 'waiting');
  assert.equal(p.code, '048213');
  assert.equal(p.error, null);
  // ...but only until the window is past its expiry: an agent that never answers again must not keep
  // the code on screen and the tab polling forever.
  const late = P.tgPairApply(waiting, 'status', {ok:false, error:'agent is not running'}, NOW + 300_000 + P.TG_PAIR_GRACE_MS + 1);
  assert.equal(late.phase, 'expired');
  assert.equal(late.code, null);
  assert.equal(P.tgPairPolling(late), false);
});

test('an agent without the route (404) shows the update note instead of a Pair button', () => {
  const p = P.tgPairApply(P.tgPairInitial(), 'status', {ok:false, unsupported:true, error:'this agent has no Telegram pairing route'}, NOW);
  assert.equal(p.supported, false);
  const html = P.tgPairCardHTML(p, ctx, h);
  assert.ok(html.includes('NOTE'));
  assert.ok(!html.includes('telegram:pairStart'));
  // A start that meets the 404 lands in the same place.
  assert.equal(P.tgPairApply(P.tgPairInitial(), 'start', {ok:false, unsupported:true, error:'x'}, NOW).supported, false);
});

test('an owner the tab did not know asks for the replace confirmation; not running says to restart', () => {
  const ask = P.tgPairApply(P.tgPairInitial(), 'start', {ok:false, code:'owner_already_paired', error:'This bot already has an owner.'}, NOW);
  assert.equal(ask.askReplace, true);
  assert.equal(ask.phase, 'idle');
  assert.equal(ask.error, null);
  const down = P.tgPairApply(P.tgPairInitial(), 'start', {ok:false, code:'telegram_not_running', error:'Telegram is not running (state: down).'}, NOW);
  assert.equal(down.error, P.TG_PAIR_NOT_RUNNING);
  assert.ok(P.tgPairCardHTML(down, ctx, h).includes(P.TG_PAIR_NOT_RUNNING));
  const other = P.tgPairApply(P.tgPairInitial(), 'start', {ok:false, error:'HTTP 500'}, NOW);
  assert.equal(other.error, 'Could not start pairing: HTTP 500');
});

test('the resting card shows the steps and a Pair button, with the replace label when asked', () => {
  const html = P.tgPairCardHTML(P.tgPairInitial(), ctx, h);
  assert.ok(html.includes('HOWTO'));
  assert.match(html, /data-act="telegram:pairStart"[^>]*>Pair</);
  assert.match(P.tgPairCardHTML(P.tgPairInitial(), Object.assign({}, ctx, {label:'Replace'}), h), />Replace</);
  assert.match(P.tgPairCardHTML(P.tgPairInitial(), Object.assign({}, ctx, {busy:true}), h), /pairStart" disabled/);
});

test('renderer copy: the update note names Integrations and quitting the app (ATO-822 item 1); no em dash in the pairing lines', () => {
  const line = (name) => {
    const m = source.match(new RegExp('const ' + name + " = '((?:[^'\\\\]|\\\\.)*)';"));
    assert.ok(m, name + ' is declared');
    return m[1];
  };
  const note = line('TG_PAIRING_NOTE');
  assert.ok(/Update Atomic Agent/.test(note) && /quit the app/.test(note) && /Integrations › Telegram/.test(note), note);
  assert.ok(!/Telegram tab in `atag tui`/.test(note), 'not the old "Telegram tab" wording');
  for (const name of ['TG_PAIRING_NOTE', 'TG_PAIR_HOWTO', 'TG_PAIR_HAS_OWNER']) assert.ok(!line(name).includes('—'), name);
  for (const s of [P.TG_PAIR_EXPIRED, P.TG_PAIR_NOT_RUNNING]) assert.ok(!s.includes('—'), s);
  assert.ok(!source.includes('The desktop app can\\\'t pair yet'), 'the "use the terminal" steps are gone');
});

test('renderer wiring: the pairing helper loads before renderer.js; the IPC and verbs are wired', () => {
  const helper = index.indexOf('<script src="telegram-pairing.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  assert.ok(source.includes("BR.telegramPairing('start', !!replace)"));
  assert.ok(source.includes("BR.telegramPairing('status')") && source.includes("BR.telegramPairing('cancel')"));
  for (const verb of ['pairStart', 'pairReplace', 'pairCancel']) assert.ok(source.includes("verb === '" + verb + "'"), verb);
  // Replacing a paired owner takes a second click, like Clear owner (ATO-718).
  assert.ok(source.includes("verb === 'clearToken' || verb === 'clearOwner' || verb === 'pairReplace'"));
  // Polling runs only while the Telegram tab is on screen; entering the tab asks again (and handles a claim the same way).
  assert.match(source, /if \(tgPairPolling\(TG\.pair\) && telegramVisible\(\)\) TG\.pairTimer = setTimeout\(tgPairPoll, TG_PAIR_POLL_MS\)/);
  assert.match(source, /function telegramTabEntered\(\) \{[^}]*tgPairProbe\(\)/);
  assert.ok(source.includes('await tgPairOnStatus(res, false);') && source.includes('await tgPairOnStatus(res, true);'));
  // The smoke hook never exposes the code itself.
  assert.ok(source.includes('hasCode: !!TG.pair.code'));
  assert.ok(!/console\.(log|info|warn|error)\([^)]*pair\.code/.test(source));
});
