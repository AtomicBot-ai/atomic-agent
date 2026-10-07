/** Acceptance fixtures for coverage, stable fingerprints, multiplicity and monotone reduction. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './check-test-types.mjs';

const root = mkdtempSync(join(tmpdir(), 'atomic-test-types-'));
const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const config = { compilerOptions: { target: 'ES2022', module: 'ESNext', jsx: 'preserve', strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src/**/*.ts', 'src/**/*.tsx'] };
let checks = 0;
function test(name, body) { body(); checks++; console.log(`ok: ${name}`); }
try {
  put('tsconfig.test.json', JSON.stringify(config));
  put('src/valid.ts', 'export {};\n');
  put('src/base.test.tsx', 'export const value: number = "old debt";\n');
  mkdirSync(join(root, 'docs/testing'), { recursive: true });
  const original = run(root, 'capture').current;
  assert.equal(original.diagnostics.length, 1);
  test('initial ledger passes', () => assert.equal(run(root).added.length, 0));
  test('capture cannot replace existing debt', () => assert.throws(() => run(root, 'capture'), /overwrite/));
  put('src/new.test.tsx', 'export const another: boolean = 42;\n');
  test('new TSX error fails and reduce refuses growth', () => {
    assert.equal(run(root).added.length, 1);
    assert.equal(run(root, 'reduce').written, undefined);
  });
  rmSync(join(root, 'src/new.test.tsx'));
  put('src/base.test.tsx', 'export const value: number = "old debt";\nexport namespace Nested { export const value: number = "old debt"; }\n');
  test('duplicate diagnostic consumes another entry', () => {
    const r = run(root);
    assert.equal(r.current.diagnostics.length, 1);
    assert.equal(r.current.diagnostics[0].count, 2);
    assert.equal(r.added.reduce((n, d) => n + d.count, 0), 1);
  });
  put('src/base.test.tsx', '\n// a shifted line\nexport const value: number = "old debt";\n');
  test('line shifts retain the fingerprint', () => {
    const r = run(root); assert.equal(r.added.length, 0); assert.equal(r.removed.length, 0);
  });
  put('src/new.test.tsx', 'export const valid: boolean = true;\n');
  test('new valid TSX is covered without a new allowance', () => { const r = run(root); assert.equal(r.current.testTsx, 2); assert.equal(r.added.length, 0); });
  put('tsconfig.test.json', JSON.stringify({ ...config, include: ['src/**/*.ts'] }));
  test('omitted TSX fails coverage', () => assert.throws(() => run(root), /omitted/));
  put('tsconfig.test.json', JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, strict: false } }));
  test('weakened options cannot be reduced into the ledger', () => { const r = run(root, 'reduce'); assert.match(r.errors.join(), /options changed/); assert.equal(r.written, undefined); });
  put('tsconfig.test.json', JSON.stringify(config));
  put('src/base.test.tsx', 'export const value: number = 1;\n');
  test('fixed errors require shrinking the ledger', () => { const r = run(root); assert.equal(r.removed.length, 1); assert.equal(r.added.length, 0); });
  test('reduce only removes resolved allowances', () => { assert.equal(run(root, 'reduce').written, true); assert.equal(run(root).removed.length, 0); });
  const path = join(root, 'docs/testing/test-type-debt.json');
  const changed = JSON.parse(readFileSync(path, 'utf8')); changed.typescript = '0.0.0'; writeFileSync(path, JSON.stringify(changed));
  test('compiler upgrades require explicit review', () => assert.match(run(root).errors.join(), /TypeScript changed/));
  console.log(`test type self-test: ${checks} checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
