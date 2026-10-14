// Every driver's launch() refuses the operator's real profile (ATO-360).
// A driven run on a test Mac once started a real 27B model and rewrote the
// real config because a launcher let the real state dir through. Nothing
// here starts an app: the launcher cases point at a fake CDP endpoint, so
// a launcher that skips the guard stops on "port busy" instead of spawning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertThrowawayStateDir } from './state-guard.mjs';
import { launch as launchDrive } from './drive.mjs';
import { launch as launchUx } from './drive-ux.mjs';
import { launch as launchSelector } from './drive-selector-lib.mjs';
import { launch as launchCloud } from './drive-cloud-lib.mjs';

const root = mkdtempSync(join(tmpdir(), 'atag-state-guard-'));
const home = join(root, 'home');
const live = join(home, '.atomic-agent-desktop');
const tui = join(home, '.atomic-agent');
mkdirSync(live, { recursive: true });
mkdirSync(tui, { recursive: true });
const linkToLive = join(root, 'looks-like-scratch');
symlinkSync(live, linkToLive, 'junction');
const opts = { home, env: {} };

let squatter;
let port;
let savedHome;
before(async () => {
  savedHome = process.env.HOME;
  process.env.HOME = home;
  squatter = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  });
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  port = squatter.address().port;
});
after(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  squatter.close();
  rmSync(root, { recursive: true, force: true });
});

test('a fresh scratch dir is allowed, existing or not', () => {
  const scratch = mkdtempSync(join(root, 'lane-'));
  assert.doesNotThrow(() => assertThrowawayStateDir(scratch, opts));
  assert.doesNotThrow(() => assertThrowawayStateDir(join(root, 'not-made-yet'), opts));
});

test('no state dir is refused', () => {
  for (const missing of [undefined, null, '', '   ']) {
    assert.throws(() => assertThrowawayStateDir(missing, opts), /real app data/);
  }
});

test('a relative state dir is refused: the app would fall back to its default', () => {
  assert.throws(() => assertThrowawayStateDir('lane-a', opts), /relative state dir/);
  assert.throws(() => assertThrowawayStateDir('./tmp/lane', opts), /relative state dir/);
});

test('the real profiles are refused, however they are spelled', () => {
  for (const dir of [live, tui, `${live}/`, join(home, 'x', '..', '.atomic-agent-desktop'), linkToLive]) {
    assert.throws(() => assertThrowawayStateDir(dir, opts), /real app data/, dir);
  }
});

test('a desktop dir named by ATOMIC_AGENT_DESKTOP_STATE_DIR is refused', () => {
  const named = join(root, 'operator-desktop');
  mkdirSync(named, { recursive: true });
  assert.throws(
    () => assertThrowawayStateDir(named, { home, env: { ATOMIC_AGENT_DESKTOP_STATE_DIR: named } }),
    /real app data/,
  );
});

test('the installed app profile under Application Support is refused on macOS', { skip: process.platform === 'win32' }, () => {
  const support = join(home, 'Library', 'Application Support', 'Atomic Agent');
  assert.throws(() => assertThrowawayStateDir(support, { ...opts, platform: 'darwin' }), /real app data/);
});

const launchers = {
  'drive.mjs': (stateDir) => launchDrive({ port, stateDir, verbose: false }),
  'drive-ux.mjs': (stateDir) => launchUx({ port, stateDir }),
  'drive-selector-lib.mjs': (stateDir) => launchSelector({ port, stateDir }),
  'drive-cloud-lib.mjs': (stateDir) => launchCloud({ port, stateDir }),
};

for (const [name, launch] of Object.entries(launchers)) {
  test(`${name} launch() refuses a symlink to the real profile`, async () => {
    await assert.rejects(launch(linkToLive), /real app data/);
  });
  test(`${name} launch() refuses a relative state dir`, async () => {
    await assert.rejects(launch('relative-lane'), /relative state dir/);
  });
}
