import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../out/main/updater.js');

/** ATO-573: an AppImage updates itself; a .deb and other Linux installs do not. */
test('only macOS, Windows and a Linux AppImage replace themselves', () => {
  assert.equal(U.selfUpdatingInstall('darwin', {}), true);
  assert.equal(U.selfUpdatingInstall('win32', {}), true);
  assert.equal(U.selfUpdatingInstall('linux', { APPIMAGE: '/home/me/Atomic Agent.AppImage' }), true);
  assert.equal(U.selfUpdatingInstall('linux', {}), false);
  assert.equal(U.selfUpdatingInstall('linux', { APPIMAGE: '  ' }), false);
});

/** ATO-575: the beta switch moves the feed channel; off, the build's own. */
test('beta reads the beta channel, off reads the build channel', () => {
  assert.equal(U.effectiveChannel('stable', { beta: true }), 'beta');
  assert.equal(U.effectiveChannel('stable', { beta: false }), 'stable');
  assert.equal(U.effectiveChannel('canary', { beta: false }), 'canary');
});

test('updates.json keeps the beta choice and defaults it off', () => {
  assert.equal(U.coerceUpdatePrefs({}).beta, false);
  assert.equal(U.coerceUpdatePrefs({ beta: true }).beta, true);
  assert.equal(U.coerceUpdatePrefs({ beta: 'yes' }).beta, false);
});

test('pointing the updater at a channel never leaves a downgrade allowed', () => {
  // As electron-updater: setting the channel turns allowDowngrade on.
  const u = { _c: null, allowDowngrade: false, get channel() { return this._c; }, set channel(v) { this._c = v; this.allowDowngrade = true; } };
  U.readChannel(u, 'beta');
  assert.equal(u.channel, 'beta');
  assert.equal(u.allowDowngrade, false);
  U.readChannel(u, 'stable');
  assert.equal(u.allowDowngrade, false);
});
