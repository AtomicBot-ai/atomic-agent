import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../out/main/background-mode.js');
const { menuTemplate } = require('../out/main/menu.js');

/** ATO-598: keep running in the tray and start at login are opt-in, off by default. */
test('off by default: closing the last window quits off macOS, never on macOS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mode-'));
  const prefs = B.readBackgroundPrefs(dir);
  assert.deepEqual(prefs, { keepRunning: false });
  assert.equal(B.quitsOnLastWindow('win32', prefs), true);
  assert.equal(B.quitsOnLastWindow('linux', prefs), true);
  assert.equal(B.quitsOnLastWindow('darwin', prefs), false);
});

test('Keep Running keeps the app alive after the last window, and is remembered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mode-'));
  B.writeBackgroundPrefs(dir, { keepRunning: true });
  const prefs = B.readBackgroundPrefs(dir);
  assert.equal(prefs.keepRunning, true);
  assert.equal(B.quitsOnLastWindow('win32', prefs), false);
});

test('the Linux autostart entry starts an AppImage by its own path, quoted when needed', () => {
  const entry = B.linuxAutostartEntry('/tmp/.mount_x/atomic-agent', { APPIMAGE: '/home/me/Apps/Atomic Agent.AppImage' });
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /\nExec="\/home\/me\/Apps\/Atomic Agent\.AppImage"\n/);
  assert.match(B.linuxAutostartEntry('/opt/atomic/atomic-agent', {}), /\nExec=\/opt\/atomic\/atomic-agent\n/);
  assert.equal(B.linuxAutostartFile({ XDG_CONFIG_HOME: '/x' }, '/home/me'), '/x/autostart/atomic-agent.desktop');
  assert.equal(B.linuxAutostartFile({}, '/home/me'), '/home/me/.config/autostart/atomic-agent.desktop');
});

test('start at login goes through the login item off Linux', () => {
  let open = false;
  const host = { platform: 'win32', execPath: 'x', getLoginItemSettings: () => ({ openAtLogin: open }), setLoginItemSettings: (s) => { open = s.openAtLogin; } };
  assert.equal(B.startsAtLogin(host), false);
  assert.equal(B.setStartAtLogin(host, true), true);
  assert.equal(B.startsAtLogin(host), true);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`Agent menu carries the two checkboxes, as main has them, and sends bg:* (${platform})`, () => {
    const sent = [];
    const agent = menuTemplate((c) => sent.push(c), platform, { keepRunning: true, startAtLogin: false }).find((m) => m.label === 'Agent');
    const keep = agent.submenu.find((i) => i.label === 'Keep Running After the Window Closes');
    const login = agent.submenu.find((i) => i.label === 'Start at Login');
    assert.equal(keep.type, 'checkbox');
    assert.equal(keep.checked, true);
    assert.equal(login.checked, false);
    keep.click(); login.click();
    assert.deepEqual(sent, ['bg:keepRunning', 'bg:startAtLogin']);
  });
}
