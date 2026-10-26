// Without a seed .env the human scenarios cannot type a provider key, so
// none of them can be driven. ATO-926: that run reported "0 passed, 8 app
// failures" and exited 1, blaming the app for a stand that was not ready.
// It must say SKIPPED with the reason and never launch a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'atag-no-seed-env-'));
process.env.ATAG_TEST_ENV = join(root, 'missing.env');
process.env.ATAG_TEST_DIR = join(root, 'runs');
process.env.ATAG_TEST_PROVIDER = 'aimlapi';
const harness = await import('./harness.mjs');

test('a scenario with no seed .env is skipped before anything is set up or launched', async () => {
  let touched = false;
  const r = await harness.scenario('no-seed-env', async () => { touched = true; }, {
    firstRunFirst: false,
    // On a run that ignores the missing .env this is the next step, and it
    // stops here instead of opening a window.
    setup: () => { touched = true; throw new Error('setup reached without a seed .env'); },
  });
  assert.equal(touched, false, 'nothing about the scenario ran');
  assert.equal(r.ok, true);
  assert.equal(r.notReady, true);
  assert.match(String(r.skipped), /no seed \.env: set ATAG_TEST_ENV to a file holding AIMLAPI_API_KEY/);
});

test('a seed .env without the provider key is also a stand problem, not an app failure', () => {
  const env = join(root, 'other.env');
  writeFileSync(env, 'OPENROUTER_API_KEY=x\n');
  assert.match(harness.seedEnvProblem(env, 'aimlapi'), /has no AIMLAPI_API_KEY/);
  writeFileSync(env, 'AIMLAPI_API_KEY=abc\n');
  assert.equal(harness.seedEnvProblem(env, 'aimlapi'), null);
  // providerKey() trims the value, so a space after = is still a key.
  writeFileSync(env, 'AIMLAPI_API_KEY= abc\n');
  assert.equal(harness.seedEnvProblem(env, 'aimlapi'), null);
  writeFileSync(env, 'AIMLAPI_API_KEY=\n');
  assert.match(harness.seedEnvProblem(env, 'aimlapi'), /has no AIMLAPI_API_KEY/);
});

test('run-all counts them as skipped, not app failures, with a distinct exit code', () => {
  const why = 'no seed .env: set ATAG_TEST_ENV to a file holding AIMLAPI_API_KEY';
  const results = Array.from({ length: 8 }, (_, i) => ({ name: `0${i + 1}`, ok: true, skipped: why, notReady: true, secs: '0' }));
  const { line, code } = harness.summarize(results);
  assert.equal(line, `0 passed, 0 app failures, 0 model shortfalls, 8 skipped (${why})`);
  assert.equal(code, harness.EXIT_NOT_READY);
  assert.notEqual(code, 0);
  assert.notEqual(code, 1);
});

test('a real app failure still exits 1, and an opt-in skip alone does not change a green run', () => {
  assert.equal(harness.summarize([{ name: 'a', ok: false, error: 'x', secs: '1' }]).code, 1);
  assert.equal(harness.summarize([
    { name: 'a', ok: true, secs: '1' },
    { name: 'b', ok: true, skipped: 'opt-in', secs: '0' },
  ]).code, 0);
});
