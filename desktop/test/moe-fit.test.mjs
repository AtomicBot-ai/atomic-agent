// ATO-2455: main/moe-fit.ts, against the built output (npm run build first).
// The agent's `models recommend --json` says which models fit with experts in
// RAM; the desktop, which cannot see the GPU, puts it on its rows.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {parseMoeFitFacts, withExpertsInRam, moeFitFactsNow, forgetMoeFitFacts} = require('../out/main/moe-fit.js');

const AGENT = JSON.stringify({
  version: 1,
  machine: {ramGb: 32, gpuBudgetGb: 8.6, freeDiskGb: 400, cpuOnly: false, dedicatedGpu: true, cpuMoe: 'auto'},
  expertsInRam: [
    {id: 'qwen-3.6-35b-a3b', fitLabel: 'Fits, experts in RAM', tier: 'fits', speed: '~10 tok/s, estimate'},
    {id: 'odd', tier: 'too-big'},
  ],
  tiers: {},
});

test('reads the facts; an agent without them gives none', () => {
  const f = parseMoeFitFacts(AGENT);
  assert.equal(f.dedicatedGpu, true);
  assert.equal(f.gpuBudgetGb, 8.6);
  assert.equal(f.cpuMoe, 'auto');
  assert.deepEqual(Object.keys(f.byId), ['qwen-3.6-35b-a3b']);
  assert.equal(parseMoeFitFacts(JSON.stringify({version: 1, machine: {ramGb: 32}, tiers: {}})), null);
  assert.equal(parseMoeFitFacts('not json'), null);
  assert.equal(parseMoeFitFacts(null), null);
});

test('marks only the rows the agent names, and none with cpuMoe off', () => {
  const list = {ok: true, models: [{id: 'qwen-3.6-35b-a3b'}, {id: 'qwen-3.5-4b'}]};
  const out = withExpertsInRam(list, parseMoeFitFacts(AGENT));
  assert.deepEqual(out.models[0].expertsInRam, {tier: 'fits', speed: '~10 tok/s, estimate'});
  assert.equal(out.models[1].expertsInRam, undefined);
  const off = parseMoeFitFacts(AGENT.replace('"cpuMoe":"auto"', '"cpuMoe":"off"'));
  assert.equal(withExpertsInRam(list, off), list);
  assert.equal(withExpertsInRam(list, null), list);
});

test('reads once in the background, never on a Mac, again after a forget', async () => {
  let asked = 0;
  const fetch = async () => { asked += 1; return AGENT; };
  assert.equal(moeFitFactsNow(fetch, 'darwin'), null);
  assert.equal(asked, 0);
  forgetMoeFitFacts();
  assert.equal(moeFitFactsNow(fetch, 'win32'), null); // the first call only starts the read
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(moeFitFactsNow(fetch, 'win32').dedicatedGpu, true);
  assert.equal(asked, 1);
  forgetMoeFitFacts();
  moeFitFactsNow(fetch, 'win32');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, 2);
});

test('a failed read is not retried on every list', async () => {
  forgetMoeFitFacts();
  let asked = 0;
  const fetch = async () => { asked += 1; return null; };
  moeFitFactsNow(fetch, 'linux');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(moeFitFactsNow(fetch, 'linux'), null);
  assert.equal(asked, 1);
});
