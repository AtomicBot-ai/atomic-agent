// Every driver's launch() refuses the operator's real profile (ATO-360).
// A driven run on a test Mac once started a real 27B model and rewrote the
// real config because a launcher let the real state dir through. Nothing
// here starts an app: the launcher cases point at a fake CDP endpoint, so
// a launcher that skips the guard stops on "port busy" instead of spawning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertThrowawayStateDir, driveEnv } from './state-guard.mjs';
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

// ATO-385: the guarded dir has to be the one the app actually gets.
test('a caller env cannot swap the guarded state dir', () => {
  const scratch = mkdtempSync(join(root, 'lane-'));
  const got = driveEnv(scratch, { ATOMIC_AGENT_BIN: '/x/agent' }, { ATOMIC_AGENT_STATE_DIR: live, EXTRA: '1' }, undefined);
  assert.equal(got.ATOMIC_AGENT_STATE_DIR, scratch);
  assert.equal(got.ATOMIC_AGENT_BIN, '/x/agent');
  assert.equal(got.EXTRA, '1');
  assert.equal(driveEnv(scratch, { EXTRA: 'a' }, { EXTRA: 'b' }).EXTRA, 'b', 'later layers still win among themselves');
});

/* Spawn arguments and the spawn env are only observable by starting
   Electron, which these tests never do, so the four drivers are read as
   source: each must give Electron a throwaway --user-data-dir (otherwise it
   writes ~/Library/Application Support/Atomic Agent) and build its env
   through driveEnv. */
const HERE = dirname(fileURLToPath(import.meta.url));
for (const name of Object.keys(launchers)) {
  test(`${name} spawns Electron with a throwaway profile and the guarded env`, () => {
    const src = readFileSync(join(HERE, name), 'utf8');
    assert.match(src, /--user-data-dir=\$\{(join\()?(o\.)?stateDir/, 'no --user-data-dir inside the state dir');
    assert.match(src, /env: driveEnv\(/, 'spawn env is not built by driveEnv');
    assert.doesNotMatch(src, /ATOMIC_AGENT_STATE_DIR: (o\.)?stateDir,[^}]*\.\.\.(o\.)?env\b/, 'caller env spread after the state dir');
  });
}

test('model-picks.drive.mjs checks its state dir before making anything inside it', () => {
  const src = readFileSync(join(HERE, 'model-picks.drive.mjs'), 'utf8');
  const guard = src.indexOf('assertThrowawayStateDir(CONFIGURED)');
  assert.ok(guard > 0, 'no guard on CONFIGURED');
  assert.ok(guard < src.indexOf('mkdirSync(SCRATCH'), 'SCRATCH is made before the guard');
});
