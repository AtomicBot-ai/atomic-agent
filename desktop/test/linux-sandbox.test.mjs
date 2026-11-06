import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../out/main/linux-sandbox.js');

/** ATO-1229: Ubuntu 24.04 with an AppImage, no AppArmor profile, no setuid helper. */
const UBUNTU_2404_APPIMAGE = {
  platform: 'linux',
  env: { APPIMAGE: '/home/me/Downloads/Atomic-Agent-0.0.8-x86_64.AppImage' },
  argv: ['/tmp/.mount_AtomicXYZ/atomic-agent-desktop'],
  restrictUserns: '1\n',
  usernsClone: null,
  maxUserNamespaces: '63432\n',
  chromeSandbox: { uid: 0, mode: 0o100755 },
};

test('an AppImage on Ubuntu 24.04 (userns restricted, no setuid helper) runs without the sandbox', () => {
  const v = S.sandboxVerdict(UBUNTU_2404_APPIMAGE);
  assert.equal(v.noSandbox, true);
  assert.match(v.reason, /apparmor_restrict_unprivileged_userns=1/);
});

test('a .deb is never touched: its install gives it a profile or the setuid helper', () => {
  assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, env: {} }), { noSandbox: false });
  assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, env: { APPIMAGE: '  ' } }), { noSandbox: false });
});

test('macOS and Windows are never touched', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, platform }), { noSandbox: false });
  }
});

test('where user namespaces work (Debian 12, Ubuntu 22.04: no restriction file) nothing changes', () => {
  assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, restrictUserns: null }), { noSandbox: false });
  assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, restrictUserns: '0\n' }), { noSandbox: false });
});

test('other ways a kernel blocks unprivileged user namespaces count too', () => {
  const clone = S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, restrictUserns: null, usernsClone: '0\n' });
  assert.equal(clone.noSandbox, true);
  assert.match(clone.reason, /unprivileged_userns_clone=0/);
  const max = S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, restrictUserns: null, maxUserNamespaces: '0' });
  assert.equal(max.noSandbox, true);
  assert.match(max.reason, /max_user_namespaces=0/);
});

test('a root-owned setuid chrome-sandbox is a usable sandbox: keep it', () => {
  assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, chromeSandbox: { uid: 0, mode: 0o104755 } }), { noSandbox: false });
  // setuid but not root's, or root's but not setuid: not usable.
  assert.equal(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, chromeSandbox: { uid: 1000, mode: 0o104755 } }).noSandbox, true);
  assert.equal(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, chromeSandbox: null }).noSandbox, true);
});

test('already started with --no-sandbox (AppRun decided it): no second switch, no log', () => {
  assert.deepEqual(S.sandboxVerdict({ ...UBUNTU_2404_APPIMAGE, argv: [...UBUNTU_2404_APPIMAGE.argv, '--no-sandbox'] }), { noSandbox: false });
});

test('setuidHelperReady and usernsBlockedReason', () => {
  assert.equal(S.setuidHelperReady({ uid: 0, mode: 0o4755 }), true);
  assert.equal(S.setuidHelperReady({ uid: 0, mode: 0o755 }), false);
  assert.equal(S.setuidHelperReady(null), false);
  assert.equal(S.usernsBlockedReason({ restrictUserns: null, usernsClone: null, maxUserNamespaces: null }), null);
  assert.equal(S.usernsBlockedReason({ restrictUserns: ' 1 ', usernsClone: '1', maxUserNamespaces: '100' }), 'kernel.apparmor_restrict_unprivileged_userns=1');
});

test('probeLinuxSandbox never throws and reads nothing off Linux', () => {
  const facts = S.probeLinuxSandbox('/nonexistent/atomic-agent-desktop');
  assert.equal(facts.platform, process.platform);
  if (process.platform !== 'linux') {
    assert.equal(facts.restrictUserns, null);
    assert.equal(facts.chromeSandbox, null);
  }
});
