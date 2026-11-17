// ATO-1085: the desktop shell follows the agent's offline mode
// (main/offline-state.ts): PostHog, Sentry and the update check stay quiet.
// Run: npm run build && npm run test:unit
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const O = require('../out/main/offline-state.js');
const { PostHogTransport } = require('../out/main/analytics/transport.js');
const U = require('../out/main/updater.js');

const savedEnv = process.env.ATOMIC_AGENT_OFFLINE;
after(() => {
  if (savedEnv === undefined) delete process.env.ATOMIC_AGENT_OFFLINE;
  else process.env.ATOMIC_AGENT_OFFLINE = savedEnv;
});
beforeEach(() => {
  O.resetDesktopOfflineForTests();
  delete process.env.ATOMIC_AGENT_OFFLINE;
});

test('network.offline in config.json is read at start; anything odd is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-offline-'));
  assert.equal(O.offlineInStateDir(dir), false);
  writeFileSync(join(dir, 'config.json'), '{ not json');
  assert.equal(O.offlineInStateDir(dir), false);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, network: { offline: 'yes' } }));
  assert.equal(O.offlineInStateDir(dir), false);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, network: { offline: true } }));
  assert.equal(O.offlineInStateDir(dir), true);
});

test('ATOMIC_AGENT_OFFLINE=1 keeps it on whatever the agent answers', () => {
  assert.equal(O.desktopOffline({ ATOMIC_AGENT_OFFLINE: '1' }), true);
  assert.equal(O.desktopOffline({ ATOMIC_AGENT_OFFLINE: 'off' }), false);
  process.env.ATOMIC_AGENT_OFFLINE = 'true';
  O.setDesktopOffline(false);
  assert.equal(O.desktopOffline(), true);
});

test('only a real /api/offline-mode answer moves the switch', () => {
  const heard = [];
  O.onDesktopOfflineChange((on) => heard.push(on));
  O.followOfflineAnswer({ supported: true, ok: true, data: { enabled: true, egress: null } });
  assert.equal(O.desktopOffline(), true);
  O.followOfflineAnswer({ supported: false });
  O.followOfflineAnswer({ supported: true, ok: false, error: 'boom' });
  O.followOfflineAnswer({ supported: true, ok: true, data: { enabled: 'no' } });
  O.followOfflineAnswer(null);
  assert.equal(O.desktopOffline(), true);
  O.followOfflineAnswer({ supported: true, ok: true, data: { enabled: true } });
  O.followOfflineAnswer({ supported: true, ok: true, data: { enabled: false } });
  assert.equal(O.desktopOffline(), false);
  assert.deepEqual(heard, [true, false]);
});

test('a transport gated on the switch sends nothing while offline', async () => {
  const calls = [];
  const t = new PostHogTransport({
    canSend: () => !O.desktopOffline(),
    distinctId: () => 'id',
    fetchImpl: async (url) => { calls.push(url); return { ok: true }; },
  });
  O.setDesktopOffline(true);
  t.enqueue('app_opened', {});
  await t.flush(500);
  assert.equal(calls.length, 0);
  O.setDesktopOffline(false);
  t.enqueue('app_opened', {});
  await t.flush(500);
  assert.equal(calls.length, 1);
});

test('Check now while offline says why and asks nothing', () => {
  assert.equal(U.OFFLINE_CHECK_RESULT.kind, 'error');
  assert.equal(U.OFFLINE_CHECK_RESULT.reason, 'offline');
  assert.match(U.OFFLINE_CHECK_RESULT.message, /Offline mode is on/);
});
