// ATO-2745: where a saved key really went (renderer/key-stored-note.js), from main's answer to
// `app:dotenvSet` (storedIn, keychainFallback) and `cli:upsertProvider` (keychainFallback).
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const K = createRequire(import.meta.url)('../renderer/key-stored-note.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');

test('the line says keychain, private file, or the fallback, as main answered', () => {
  assert.equal(K.keySavedLine('Token saved.', {ok:true, storedIn:'keychain'}), 'Token saved in your system keychain.');
  assert.equal(K.keySavedLine('Token saved.', {ok:true, storedIn:'file'}), 'Token saved in a private file only your user account can read.');
  assert.equal(K.keySavedLine('Token saved. Telegram confirms the bot: @b.', {ok:true, storedIn:'file', keychainFallback:true}),
    'Token saved in a private file because the system keychain was not available. Telegram confirms the bot: @b.');
  assert.equal(K.KEY_FALLBACK, 'Saved in a private file because the system keychain was not available.');
});

test('an answer that does not say (an older main, a removal, a failure) leaves the line as it was', () => {
  for (const res of [null, {ok:true}, {ok:false, storedIn:'keychain'}, {ok:true, storedIn:'elsewhere'}]) {
    assert.equal(K.keySavedLine('Token saved.', res), 'Token saved.');
    assert.equal(K.keyStoredWhere(res), '');
  }
});

test('a provider key the keychain did not take is said once, in a toast', () => {
  const seen = [];
  const t = (...a) => seen.push(a);
  assert.equal(K.keyFallbackToast({ok:true}, t, 1000), false);
  assert.equal(K.keyFallbackToast({ok:false, keychainFallback:true}, t, 1000), false);
  assert.equal(K.keyFallbackToast({ok:true, keychainFallback:true}, t, 1000), true);
  assert.equal(K.keyFallbackToast({ok:true, keychainFallback:true}, t, 2000), false, 'the wizard\'s second pass is quiet');
  assert.equal(K.keyFallbackToast({ok:true, keychainFallback:true}, t, 1000 + K.KEY_FALLBACK_QUIET_MS), true);
  assert.deepEqual(seen, [['Key saved', K.KEY_FALLBACK], ['Key saved', K.KEY_FALLBACK]]);
  // Settings › Models › Add provider and the setup wizard both say it.
  assert.equal(source.split('keyFallbackToast(res, toast)').length - 1, 2);
});

test('no long dash in these words', () => {
  for (const w of [K.KEY_WHERE_KEYCHAIN, K.KEY_WHERE_FILE, K.KEY_WHERE_FALLBACK, K.KEY_FALLBACK]) assert.ok(!w.includes('\u2014'), w);
});
