import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCi, readQuarantine, testArgs } from './run-tests.mjs';
const root = mkdtempSync(join(tmpdir(), 'atomic-quarantine-'));
const put = (p, text) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
const item = { path: 'src/example.test.ts', owner: 'src/', status: 'quarantined', reason: 'test', issue: '#203', reproduce: 'vitest', observed: 'failure', returnCondition: 'pass' };
const registry = (tests) => put('docs/testing/quarantine.json', JSON.stringify({ schemaVersion: 1, tests }));
let count = 0;
function test(name, body) { body(); count++; console.log(`ok: ${name}`); }
try {
  put(item.path, ''); registry([item]);
  put('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: node scripts/run-tests.mjs\n');
  test('active registry creates exact exclusions', () => assert.deepEqual(testArgs(checkCi(root)), ['run', '--exclude', item.path]));
  test('released test returns to normal suite', () => assert.deepEqual(testArgs([{ ...item, status: 'released' }]), ['run']));
  test('scope and reproduction retain registry paths', () => { assert.deepEqual(testArgs([item], 'src/mcp/'), ['run', 'src/mcp/', '--exclude', item.path]); assert.deepEqual(testArgs([item], undefined, true), ['run', item.path]); });
  registry([{ ...item, owner: '' }]);
  test('unowned exclusion rejected', () => assert.throws(() => readQuarantine(root), /owner/));
  registry([item, item]); test('duplicates rejected', () => assert.throws(() => readQuarantine(root), /duplicate/));
  registry([{ ...item, path: 'src/not-there.test.ts' }]); test('missing targets rejected', () => assert.throws(() => readQuarantine(root), /missing/));
  registry([item]);
  put('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: node scripts/run-tests.mjs --exclude hidden.test.ts\n');
  test('manual exclusion rejected', () => assert.throws(() => checkCi(root), /bypasses/));
  put('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: npx vitest run\n');
  test('direct workflow bypass rejected', () => assert.throws(() => checkCi(root), /does not use/));
  console.log(`quarantine self-test: ${count} checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
