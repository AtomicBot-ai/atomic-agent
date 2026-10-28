import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../out/main/gpu-fallback.js');
const { prevSessionEnd } = require('../out/main/analytics/classify.js');

/** ATO-1030: a second GPU crash in a short while turns hardware acceleration off for the next launch. */
test('one crash keeps acceleration on, a second within the window turns it off', () => {
  const first = G.noteGpuCrash({ crashes: [], off: null }, 1_000);
  assert.equal(first.turnedOff, false);
  assert.equal(first.state.off, null);
  const second = G.noteGpuCrash(first.state, 1_000 + 60_000);
  assert.equal(second.turnedOff, true);
  assert.equal(second.state.off, 'auto');
});

test('crashes far apart do not add up', () => {
  const first = G.noteGpuCrash({ crashes: [], off: null }, 0);
  const later = G.noteGpuCrash(first.state, G.GPU_CRASH_WINDOW_MS + 1);
  assert.equal(later.turnedOff, false);
  assert.deepEqual(later.state.crashes, [G.GPU_CRASH_WINDOW_MS + 1]);
});

test('the person turning it back on forgets the crashes; off by hand stays off', () => {
  assert.deepEqual(G.setHardwareAcceleration({ crashes: [1, 2], off: 'auto' }, true), { crashes: [], off: null });
  assert.equal(G.setHardwareAcceleration({ crashes: [], off: null }, false).off, 'user');
  assert.equal(G.noteGpuCrash({ crashes: [], off: 'user' }, 5).turnedOff, false);
});

test('the state file round-trips and a broken one reads as on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-fallback-'));
  assert.deepEqual(G.readGpuState(dir), { crashes: [], off: null });
  G.writeGpuState(dir, { crashes: [7], off: 'auto' });
  assert.deepEqual(G.readGpuState(dir), { crashes: [7], off: 'auto' });
  writeFileSync(join(dir, 'gpu.json'), '{not json');
  assert.deepEqual(G.readGpuState(dir), { crashes: [], off: null });
});

test('prev_session_end names why the last session did not quit cleanly', () => {
  assert.equal(prevSessionEnd(false, 'crashed'), 'clean');
  assert.equal(prevSessionEnd(true, null), 'killed');
  assert.equal(prevSessionEnd(true, 'crashed'), 'crashed');
  assert.equal(prevSessionEnd(true, 'os_shutdown'), 'os_shutdown');
});
