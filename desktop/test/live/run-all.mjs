/**
 * Run the live smoke scenarios (`L*.mjs`) in order, one at a time.
 *
 *   node test/live/run-all.mjs           every scenario
 *   node test/live/run-all.mjs L01 file  only names containing L01 or file
 *
 * Exit code: 0 when at least one ran and none failed, 1 on any FAIL,
 * 2 when no scenario matched, 3 when everything was skipped.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXIT_NOT_READY } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = readdirSync(HERE)
  .filter((f) => /^L.*\.mjs$/.test(f))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();

const oneLine = (reason) => String(reason).split('\n')[0];
const results = [];
for (const f of files) {
  const name = f.replace(/\.mjs$/, '');
  try {
    const mod = await import(pathToFileURL(join(HERE, f)).href);
    results.push(await mod.run());
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

console.log('');
let pass = 0;
let fail = 0;
let skip = 0;
for (const r of results) {
  if (r.skipped) { skip += 1; console.log(`SKIP ${r.name}: ${oneLine(r.skipped)}`); }
  else if (r.ok) { pass += 1; console.log(`PASS ${r.name}`); }
  else { fail += 1; console.log(`FAIL ${r.name}: ${oneLine(r.error)}`); }
}
console.log(`PASS ${pass} FAIL ${fail} SKIP ${skip}`);

if (!files.length) {
  console.error(`no live scenario matched ${JSON.stringify(only)} in ${HERE}`);
  process.exit(2);
}
process.exit(fail ? 1 : pass === 0 ? EXIT_NOT_READY : 0);
