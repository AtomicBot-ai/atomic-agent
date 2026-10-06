/** One quarantine registry drives both local and PR Vitest invocation. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function readQuarantine(root = ROOT) {
  const registry = JSON.parse(readFileSync(join(root, 'docs/testing/quarantine.json'), 'utf8'));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.tests)) throw new Error('invalid quarantine registry');
  const seen = new Set();
  for (const test of registry.tests) {
    if (!/^src\/(?:[\w.-]+\/)*[\w.-]+\.test\.tsx?$/.test(test.path) || test.path.split('/').includes('..') || !existsSync(join(root, test.path)) || seen.has(test.path)) throw new Error(`invalid, missing or duplicate quarantine path: ${test.path}`);
    seen.add(test.path);
    if (!['quarantined', 'released'].includes(test.status)) throw new Error(`invalid quarantine status: ${test.path}`);
    for (const field of ['owner', 'reason', 'issue', 'reproduce', 'observed', 'returnCondition']) if (typeof test[field] !== 'string' || !test[field].trim()) throw new Error(`missing ${field}: ${test.path}`);
  }
  return registry.tests;
}
export function testArgs(records, scope, quarantine = false) {
  return quarantine ? ['run', ...records.map((t) => t.path)]
    : ['run', ...(scope ? [scope] : []), ...records.filter((t) => t.status === 'quarantined').flatMap((t) => ['--exclude', t.path])];
}
export function checkCi(root = ROOT) {
  const records = readQuarantine(root);
  const workflow = parse(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'));
  const runs = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? '');
  if (!runs.some((run) => /^\s*node scripts\/run-tests\.mjs(?:\s|$)/m.test(run))) throw new Error('PR workflow does not use the quarantine registry runner');
  if (runs.some((run) => /--exclude\b/.test(run) || /\b(?:vitest run|npm (?:run )?test)\b/.test(run))) throw new Error('PR workflow bypasses the registry with a direct test command or exclusion');
  return records;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const records = checkCi();
    if (args.length === 1 && args[0] === '--check') {
      console.log(`quarantine: ${records.filter((r) => r.status === 'quarantined').length} active, ${records.filter((r) => r.status === 'released').length} released; CI uses registry`);
    } else {
      if (args.length > 1 || (args[0]?.startsWith('-') && args[0] !== '--quarantine')) throw new Error('Usage: node scripts/run-tests.mjs [scope | --check | --quarantine]');
      const quarantine = args[0] === '--quarantine';
      const scope = quarantine ? undefined : args[0];
      if (scope && (!/^(src|eval-memory)\//.test(scope) || scope.split('/').includes('..') || !existsSync(join(ROOT, scope)))) throw new Error('scope must be an existing repository src/ or eval-memory/ path');
      if (quarantine && !records.length) throw new Error('no quarantine history to reproduce');
      const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), ...testArgs(records, scope, quarantine)], { cwd: ROOT, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.signal) throw new Error(`Vitest terminated by ${result.signal}`);
      process.exitCode = result.status ?? 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
