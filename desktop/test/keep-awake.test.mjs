import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const K = require('../out/main/keep-awake.js');
const { menuTemplate } = require('../out/main/menu.js');

/** ATO-592: Keep Computer Awake is opt-in, off by default, and says the lid still wins. */
test('off by default, remembered once chosen, junk reads as off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-awake-'));
  assert.equal(K.readKeepAwakeMode(dir), 'off');
  K.writeKeepAwakeMode(dir, 'while-working');
  assert.equal(K.readKeepAwakeMode(dir), 'while-working');
  writeFileSync(join(dir, 'keep-awake.json'), '{"mode":"forever"}');
  assert.equal(K.readKeepAwakeMode(dir), 'off');
  writeFileSync(join(dir, 'keep-awake.json'), 'not json');
  assert.equal(K.readKeepAwakeMode(dir), 'off');
});

test('the blocker is wanted only as the mode says', () => {
  assert.equal(K.blockerWanted('off', 3), false);
  assert.equal(K.blockerWanted('always', null), true);
  assert.equal(K.blockerWanted('while-working', 0), false);
  assert.equal(K.blockerWanted('while-working', null), false);
  assert.equal(K.blockerWanted('while-working', 1), true);
  // A remote agent's tasks run on its own computer.
  assert.equal(K.blockerWanted('while-working', 1, true), false);
});

test('one prevent-app-suspension blocker at most, stopped when no longer wanted', () => {
  const started = new Set();
  const calls = [];
  let next = 1;
  const host = {
    start: (type) => { calls.push(['start', type]); const id = next++; started.add(id); return id; },
    stop: (id) => { calls.push(['stop', id]); started.delete(id); },
    isStarted: (id) => started.has(id),
  };
  const b = new K.KeepAwakeBlocker(host);
  b.sync(false);
  b.sync(true);
  b.sync(true);
  assert.equal(b.held, true);
  b.sync(false);
  b.sync(false);
  assert.equal(b.held, false);
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 1]]);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`Agent menu has Keep Computer Awake with three choices and the lid note (${platform})`, () => {
    const sent = [];
    const agent = menuTemplate((c) => sent.push(c), platform, { keepRunning: false, startAtLogin: false, keepAwake: 'while-working' })
      .find((m) => m.label === 'Agent');
    const awake = agent.submenu.find((i) => i.label === 'Keep Computer Awake');
    const radios = awake.submenu.filter((i) => i.type === 'radio');
    assert.deepEqual(radios.map((i) => i.label), ['Off', 'While a Task Runs', 'Always']);
    assert.deepEqual(radios.map((i) => i.checked), [false, true, false]);
    const note = awake.submenu.find((i) => i.label === K.KEEP_AWAKE_LID_NOTE);
    assert.equal(note.enabled, false);
    assert.match(note.label, /MacBook lid still puts it to sleep/);
    for (const r of radios) r.click();
    assert.deepEqual(sent, ['awake:off', 'awake:while-working', 'awake:always']);
  });
}

test('without a keepAwake toggle the menu shows Off', () => {
  const agent = menuTemplate(() => {}, 'darwin').find((m) => m.label === 'Agent');
  const awake = agent.submenu.find((i) => i.label === 'Keep Computer Awake');
  assert.equal(awake.submenu.find((i) => i.checked).label, 'Off');
});
