import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerDoctorDataIpc, parseDoctorJson, SHARED_FOLDER_WARNING } = require('../out/main/doctor-data.js');
const { doctorDataHTML, doctorDataAct, DOCD } = require('../renderer/doctor-data.js');

/* ATO-577 / ATO-579: Settings › Diagnostics' Doctor and Data rows. */
function harness(over = {}) {
  const handlers = {};
  const log = [];
  const boxes = [];
  const deps = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/b.tar.gz' }),
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/Volumes/Disk2'] }),
      showMessageBox: async (_w, o) => { boxes.push(o || _w); return { response: over.answer ?? 0 }; },
    },
    window: () => null,
    stateDir: '/Users/x/.atomic-agent',
    run: async (args) => { log.push('run ' + args.join(' ')); return over.result ?? { ok: true, stdout: 'done\n', stderr: '' }; },
    stopModels: async () => { log.push('stopModels'); },
    stopAgent: async () => { log.push('stopAgent'); },
    startAgent: async () => { log.push('startAgent'); },
    turnsInFlight: () => 0,
    isRemote: () => over.remote ?? false,
    relaunch: () => { log.push('relaunch'); },
  };
  registerDoctorDataIpc(deps);
  return { handlers, log, boxes };
}

test('doctor findings are parsed; anything else is null', () => {
  assert.deepEqual(parseDoctorJson('[{"check":"config","status":"ok","message":"m"}]'), [{ check: 'config', status: 'ok', message: 'm' }]);
  assert.equal(parseDoctorJson('nope'), null);
});

test('a fix that rewrote config.json restarts the agent', async () => {
  const h = harness({ result: { ok: true, stdout: '[]', stderr: 'backed up config.json to /x\n' } });
  const r = await h.handlers['doctor:run'](null, true);
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  assert.deepEqual(h.log, ['run doctor --fix --json', 'stopAgent', 'startAgent']);
});

test('a failing check still lists its findings (doctor exits 1)', async () => {
  const h = harness({ result: { ok: false, stdout: '[{"check":"model","status":"fail","message":"x"}]', stderr: '' } });
  const r = await h.handlers['doctor:run'](null, false);
  assert.equal(r.findings[0].status, 'fail');
});

test('reset asks first, says the terminal shares the folder, then stops, runs and relaunches the app', async () => {
  const h = harness();
  const r = await h.handlers['data:reset']();
  assert.equal(r.ok, true);
  assert.ok(h.boxes[0].detail.includes(SHARED_FOLDER_WARNING));
  assert.deepEqual(h.log, ['stopAgent', 'stopModels', 'run data reset --keep-models --yes', 'relaunch']);
});

test('a cancelled reset touches nothing', async () => {
  const h = harness({ answer: 1 });
  const r = await h.handlers['data:reset']();
  assert.equal(r.cancelled, true);
  assert.deepEqual(h.log, []);
});

test('move goes into <picked>/atomic-agent; a failed run still restarts the agent', async () => {
  const h = harness({ result: { ok: false, stdout: '/Volumes/Disk2/atomic-agent is not empty; pick a new or empty folder\n', stderr: '' } });
  const r = await h.handlers['data:move']();
  assert.equal(r.ok, false);
  assert.match(r.error, /not empty/);
  assert.deepEqual(h.log, ['stopAgent', 'stopModels', 'run data move /Volumes/Disk2/atomic-agent', 'startAgent']);
});

test('backup runs without stopping anything; on a remote agent nothing runs', async () => {
  const h = harness();
  assert.equal((await h.handlers['data:backup']()).ok, true);
  assert.deepEqual(h.log, ['run data backup /tmp/b.tar.gz']);
  const remote = harness({ remote: true });
  assert.equal((await remote.handlers['data:restore']()).ok, false);
  assert.deepEqual(remote.log, []);
});

test('the pane lists findings and offers Fix only when something is fixable', async () => {
  const esc = (s) => String(s);
  const html = doctorDataHTML({ findings: [{ check: 'mcp', status: 'warn', message: 'm', fix: 'turn it off' }], busy: '' }, { esc, ic: () => '' });
  assert.match(html, /data-act="doctor:fix"/);
  assert.match(html, /terminal agent \(atag\) shares/);
  assert.doesNotMatch(doctorDataHTML({ findings: [{ check: 'c', status: 'ok', message: 'm' }], busy: '' }, { esc, ic: () => '' }), /doctor:fix/);
  let reloaded = false;
  await doctorDataAct('reset', { dataReset: async () => ({ ok: true, message: 'reset' }) }, () => { reloaded = true; });
  assert.equal(reloaded, true);
  DOCD.busy = '';
});
