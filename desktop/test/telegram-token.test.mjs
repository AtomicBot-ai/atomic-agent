// Settings › Connections › Telegram, the Connect card and the token field
// (ATO-426, U-76 / U-77), renderer side: the token's shape rule, the card's
// steps and @BotFather button, the prompt's placeholder / Show-Hide / Save
// state, what a Telegram check's answer does to the save, and the tab's
// single-letter keys staying out of text fields and off T / O. The helpers
// come from renderer/telegram-token.js; renderer.js, index.html, preload.ts
// and main.ts are read as text for the wiring. Every token here is a dummy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const T = require('../renderer/telegram-token.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (n) => '<i data-ic="' + n + '"></i>'};
const TOKEN = '123456789:AAF1xYzDummyTokenValue_0123456789abcd';

/* One top-level function of renderer.js as text (check-key-button.test.mjs). */
function fn(name) {
  let at = source.indexOf('\nfunction ' + name + '(');
  if (at < 0) at = source.indexOf('\nasync function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  return source.slice(at + 1, source.indexOf('\n}\n', at) + 2);
}

test('the shape rule: empty and unshaped values are refused before anything is written; a token passes trimmed', () => {
  assert.deepEqual(T.tgTokenClean(''), {ok:false, error:T.TG_TOKEN_EMPTY});
  assert.deepEqual(T.tgTokenClean('   '), {ok:false, error:T.TG_TOKEN_EMPTY});
  for (const bad of ['desktop smoke:token #1', 'not-a-token', '123456789', ':AAF1xYzDummyTokenValue_0123456789abcd', '123456789:short', '123456789:AAF1/../x_0123456789abcdefghijklmnop']) {
    const r = T.tgTokenClean(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.error, T.TG_TOKEN_SHAPE, bad);
  }
  assert.deepEqual(T.tgTokenClean('  ' + TOKEN + '\n'), {ok:true, value:TOKEN});
  assert.ok(T.TG_TOKEN_SHAPE.includes(T.TG_TOKEN_PLACEHOLDER), 'the error shows what a token looks like');
  assert.equal(T.tgTokenSaveEnabled(''), false);
  assert.equal(T.tgTokenSaveEnabled('  '), false);
  assert.equal(T.tgTokenSaveEnabled('x'), true);
});

test('a check that confirms the bot saves and names it; a rejection saves nothing; an unreachable Telegram saves with a warning', () => {
  const ok = T.tgTokenCheckOutcome({ok:true, username:'my_bot', botId:1});
  assert.equal(ok.save, true);
  assert.equal(ok.bot, '@my_bot');
  assert.ok(ok.message.includes('@my_bot') && ok.message.startsWith('Token saved.'), ok.message);
  const noName = T.tgTokenCheckOutcome({ok:true, username:null, botId:1});
  assert.equal(noName.save, true);
  assert.ok(noName.message.includes('your bot'));
  const rejected = T.tgTokenCheckOutcome({ok:false, rejected:true, status:401, error:'Telegram did not accept the token (HTTP 401).'});
  assert.deepEqual(rejected, {save:false, message:null, error:T.TG_TOKEN_REJECTED, bot:null});
  for (const res of [{ok:false, rejected:false, status:0, error:'Could not reach Telegram: the request timed out.'}, null, undefined, {}]) {
    const r = T.tgTokenCheckOutcome(res);
    assert.equal(r.save, true, JSON.stringify(res));
    assert.ok(r.message.includes(T.TG_TOKEN_UNCHECKED), r.message);
  }
});

test('the Connect card (U-76) says what the bot is for, lists three steps and opens @BotFather', () => {
  const html = T.tgConnectCardHTML(h);
  assert.ok(html.includes('data-tg-connect'));
  assert.match(html, /from your phone/);
  assert.ok(html.includes('<ol class="sd-steps'), 'numbered steps, as the Composio pane has');
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal(T.TG_SETUP_STEPS.length, 3);
  assert.ok(T.TG_SETUP_STEPS[0].includes('@BotFather') && T.TG_SETUP_STEPS[0].includes('/newbot'));
  assert.ok(T.TG_SETUP_STEPS[1].includes(T.TG_TOKEN_PLACEHOLDER));
  assert.match(html, /data-act="telegram:botfather"[^>]*>.*Open @BotFather</);
  assert.ok(html.includes('data-act="telegram:token"'));
  assert.equal(T.TG_BOTFATHER_URL, 'https://t.me/BotFather');
  assert.ok(!/DM your bot/.test(html) && !/paste it here\./.test(html), 'the old one-line instruction is gone');
  // Without a logo helper the card still has its mark.
  assert.ok(html.includes('data-ic="send"'));
  assert.ok(T.tgConnectCardHTML(Object.assign({}, h, {logo: () => '<span class="logo"></span>'})).includes('<span class="logo"></span>'));
});

test('the token prompt (U-77): the shape as placeholder, a Show / Hide eye, Save disabled until there is text', () => {
  const empty = T.tgTokenPromptCardHTML(T.tgTokenInitial(), h);
  assert.ok(empty.includes('id="tg-token" type="password"'));
  assert.ok(empty.includes('placeholder="' + T.TG_TOKEN_PLACEHOLDER + '"'));
  assert.match(empty, /data-act="telegram:tokenReveal" aria-pressed="false"[^>]*>(<i data-ic="eye"><\/i>)</);
  assert.match(empty, /data-act="telegram:tokenSave" disabled>Save</);
  assert.ok(!empty.includes('data-tg-token-error'));
  const typed = T.tgTokenPromptCardHTML(Object.assign(T.tgTokenInitial(), {hasText:true}), h);
  assert.match(typed, /data-act="telegram:tokenSave">Save</);
  const shown = T.tgTokenPromptCardHTML(Object.assign(T.tgTokenInitial(), {hasText:true, shown:true}), h);
  assert.ok(shown.includes('id="tg-token" type="text"'));
  assert.match(shown, /aria-pressed="true"[^>]*>(<i data-ic="eyeOff"><\/i>)</);
  const checking = T.tgTokenPromptCardHTML(Object.assign(T.tgTokenInitial(), {hasText:true, checking:true}), h);
  assert.ok(checking.includes('checking with Telegram'));
  assert.match(checking, /data-act="telegram:tokenSave" disabled>Save</);
  assert.ok(checking.includes('id="tg-token" type="password" autocomplete="off" spellcheck="false" aria-label="Bot token" placeholder="' + T.TG_TOKEN_PLACEHOLDER + '" disabled>'));
  const failed = T.tgTokenPromptCardHTML(Object.assign(T.tgTokenInitial(), {hasText:true, error:T.TG_TOKEN_REJECTED}), h);
  assert.ok(failed.includes('sd-tokwrap is-error'));
  assert.match(failed, /data-tg-token-error>Telegram did not accept this token\./);
  // The prompt never carries a token value: the field has no value attribute.
  assert.ok(!/id="tg-token"[^>]*value=/.test(shown));
});

test('no em dash in any line the tab shows', () => {
  const words = [T.TG_TOKEN_EMPTY, T.TG_TOKEN_SHAPE, T.TG_TOKEN_REJECTED, T.TG_TOKEN_UNCHECKED, ...T.TG_SETUP_STEPS,
    T.tgConnectCardHTML(h), T.tgTokenPromptCardHTML(T.tgTokenInitial(), h), T.tgTokenCheckOutcome({ok:true, username:'b'}).message];
  for (const s of words) assert.ok(!s.includes('—'), s);
});

test('renderer wiring: the helper loads before renderer.js; the card, the prompt, the check and the verbs are wired', () => {
  const helper = index.indexOf('<script src="telegram-token.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  assert.ok(source.includes('tgConnectCardHTML({esc, ic, logo: logoHTML})'));
  assert.ok(!source.includes('Create a bot with @BotFather, copy the token, and paste it here.'), 'the old one-line card is gone');
  assert.ok(source.includes('function tgTokenPromptHTML() { return tgTokenPromptCardHTML(TG.token, {esc, ic}); }'));
  for (const verb of ['botfather', 'tokenReveal']) assert.ok(source.includes("verb === '" + verb + "'"), verb);
  assert.ok(source.includes('BR.openExternal(TG_BOTFATHER_URL)'));
  assert.ok(source.includes("if (e.target.id === 'tg-token') { tgTokenTyped(e.target); return; }"), 'the input delegate drives Save');
  // The save: shape first, then Telegram, and a rejected token returns before the .env write.
  const save = fn('tgTokenSave');
  assert.ok(save.includes('tgTokenClean(raw)'));
  assert.ok(save.includes('BR.telegramCheckToken(trimmed)'));
  const refuse = save.indexOf('if (!outcome.save)');
  const write = save.indexOf("BR.dotenvSet(stateDir, 'TELEGRAM_BOT_TOKEN', trimmed)");
  assert.ok(refuse > 0 && write > refuse, 'a rejected token is never written');
  assert.ok(save.includes('TG.bot = outcome.bot'));
  // Only the smoke's writer round trip skips the checks, and it says so.
  assert.ok(source.includes("tgTokenSave(value, {raw:true})"));
  assert.equal((source.match(/\{raw:true\}/g) || []).length, 1, 'no second caller skips the checks');
  // The bridge and its handler, never logging the value.
  assert.ok(preload.includes('telegramCheckToken: (value: string) => ipcRenderer.invoke("telegram:checkToken", { value })'));
  assert.ok(main.includes('ipcMain.handle("telegram:checkToken"'));
  assert.ok(main.includes('return checkTelegramToken({ token: value });'));
  assert.ok(!/console\.(log|info|warn|error)\([^)]*tg-token/.test(source));
});

/* The tab's keys, run as written: a letter typed into a field is the field's; no key removes the token or the owner. */
function keysContext() {
  const calls = [];
  const c = vm.createContext({
    TG: {mode:'list', token:T.tgTokenInitial()},
    tgHasToken: () => true, tgOwner: () => 4242,
    telegramAct: (what) => calls.push(what), tgTokenSave: () => calls.push('save'),
  });
  vm.runInContext(fn('telegramKey'), c);
  return {c, calls};
}
const ev = (key, target, mods) => Object.assign({key, target: target || {id:''}, metaKey:false, ctrlKey:false, altKey:false, shiftKey:false, prevented:false, preventDefault() { this.prevented = true; }}, mods || {});

test('keys: letters typed into a text field never reach the tab (the Gmail / Slack rule), the token field keeps Enter and Escape', () => {
  const {c, calls} = keysContext();
  for (const k of ['t', 'o', 'e', 'r', 'R', 'T', 'O']) {
    const e = ev(k, {id:'some-input'});
    assert.equal(c.telegramKey(e, k, true), false, k);
    assert.equal(e.prevented, false, k);
  }
  assert.deepEqual(calls, []);
  const enter = ev('Enter', {id:'tg-token'});
  assert.equal(c.telegramKey(enter, 'Enter', true), true);
  assert.deepEqual(calls, ['save']);
  const esc = ev('Escape', {id:'tg-token'});
  assert.equal(c.telegramKey(esc, 'Escape', true), true);
  assert.deepEqual(calls, ['save', 'tokenCancel']);
  assert.equal(c.telegramKey(ev('t', {id:'tg-token'}), 't', true), false, 'a letter in the token field is typed, not a shortcut');
});

test('keys: Shift+T and Shift+O do nothing; no letter removes the token or clears the owner', () => {
  const {c, calls} = keysContext();
  for (const k of ['T', 'O']) {
    const e = ev(k, {id:''}, {shiftKey:true});
    assert.equal(c.telegramKey(e, k, false), false, k);
    assert.equal(e.prevented, false, k);
  }
  assert.deepEqual(calls, []);
  const text = fn('telegramKey');
  assert.ok(!/['"]T['"]\s*:|['"]O['"]\s*:|T:'clearToken'|O:'clearOwner'/.test(text), 'no T / O binding');
  assert.ok(!text.includes('clearToken') && !text.includes('clearOwner'), 'removing the token or the owner is a button with a second click, never a key');
  // The letters that remain are the TUI's (telegram-key-bindings.ts), none of them destructive.
  for (const [k, verb] of [['e', 'enable'], ['t', 'token'], ['o', 'pair'], ['r', 'restart'], ['R', 'refresh']]) {
    const e = ev(k, {id:''});
    assert.equal(c.telegramKey(e, k, false), true, k);
    assert.equal(calls[calls.length - 1], verb);
  }
  // In the token prompt, with focus on one of its buttons, letters are not shortcuts either.
  c.TG.mode = 'tokenPrompt';
  const before = calls.length;
  for (const k of ['t', 'o', 'e', 'r']) assert.equal(c.telegramKey(ev(k, {id:''}), k, false), false, k);
  assert.equal(calls.length, before);
});

test('the full smoke checks the new Connect card, not the old one-line text (ATO-426 review)', () => {
  assert.ok(!main.includes('Create a bot with @BotFather, copy the token'), 'main.ts smoke still expects the removed sentence');
  assert.ok(main.includes('tgBody.includes("Talk to Atomic Agent from your phone")'));
  assert.ok(T.tgConnectCardHTML(h).includes('Talk to Atomic Agent from your phone'), 'the card and the smoke agree');
});

// ATO-2745: the prompt no longer promises a file before the save (the keychain may hold it), the Connect
// button has no useless "Enter" tooltip, a failed save keeps the raw answer behind Details, and the line
// after a save says where the token really went.
test('ATO-2745: honest storage words, no title="Enter", and Details for a failed save', () => {
  const prompt = T.tgTokenPromptCardHTML(T.tgTokenInitial(), h);
  assert.ok(!prompt.includes('a file only your user account can read'));
  assert.match(prompt, /saved only on this computer\./);
  assert.ok(!T.tgConnectCardHTML(h).includes('title="Enter"'));
  const failed = T.tgTokenPromptCardHTML(Object.assign(T.tgTokenInitial(), {hasText:true, error:'Could not save the token.', errorDetail:'keychain <locked>'}), h);
  assert.match(failed, /data-tg-token-error>Could not save the token\.<\/p><details class="set-errmore"><summary>Details<\/summary><span>keychain &lt;locked&gt;<\/span><\/details>/);
  assert.ok(!T.tgTokenPromptCardHTML(Object.assign(T.tgTokenInitial(), {errorDetail:'stale'}), h).includes('Details'));
  assert.ok(source.includes("const savedLine = keySavedLine(outcome.message, res);"));
  assert.ok(source.includes("TG.token.error = 'Could not save the token.'; TG.token.errorDetail = "));
  const note = index.indexOf('<script src="key-stored-note.js">');
  assert.ok(note > 0 && note < index.indexOf('<script src="telegram-token.js">') && note < index.indexOf('<script src="discord-settings.js">'));
});

// ATO-2745: the tab's other failures (turn on, remove the token, clear the owner, read the token)
// are a plain line with the raw answer behind Details, and a later line never shows an older answer.
test('ATO-2745: tgFail gives a plain line and Details that belong to it', () => {
  const st = {lastError: null, lastErrorDetail: null};
  T.tgFail(st, 'Could not turn Telegram on', {ok:false, error:'config changed since it was read'});
  assert.equal(st.lastError, 'Could not turn Telegram on.');
  assert.equal(T.tgErrorDetailHTML(st, h), '<details class="set-errmore"><summary>Details</summary><span>config changed since it was read</span></details>');
  T.tgFail(st, 'Could not remove the token', null);
  assert.equal(st.lastError, 'Could not remove the token.');
  assert.equal(T.tgErrorDetailHTML(st, h), '', 'no answer, no Details');
  T.tgFail(st, 'Could not clear the owner', {ok:false, error:'<locked>'});
  st.lastError = 'Something else.';
  assert.equal(T.tgErrorDetailHTML(st, h), '', 'an older answer is not shown under a newer line');
  for (const what of ['Could not turn Telegram on', 'Could not remove the token', 'Could not clear the owner', 'Could not read the saved token']) {
    assert.ok(source.includes("tgFail(TG, '" + what + "'"), what);
  }
  assert.ok(source.includes("tgFail(TG, 'Could not turn Telegram ' + (enabled ? 'on' : 'off'), res)"));
  assert.ok(!/TG\.lastError = 'Could not [^']*: ' \+/.test(source), 'no raw answer glued onto a Telegram line');
  assert.ok(source.includes("esc(TG.lastError) + tgErrorDetailHTML(TG, {esc})"));
});
