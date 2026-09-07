/**
 * Run every human scenario, in order, one at a time.
 *
 * They share a CDP port and each one opens a window, so they cannot
 * overlap — this is deliberately serial. Each scenario is also runnable on
 * its own (`node desktop/test/scenarios/04-a-conversation.mjs`) which is
 * what you want while chasing one failure.
 *
 * These are SLOW and they spend real tokens on a real provider. See
 * desktop/README.md.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = readdirSync(HERE)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();

if (!files.length) {
  console.error(`no scenarios matched ${JSON.stringify(only)} in ${HERE}`);
  process.exit(2);
}

console.log(`atag desktop — ${files.length} human scenario(s), provider ${PROVIDER}`);
console.log('These drive the real app with real clicks against a real model. Expect minutes, and real tokens.');

const results = [];
for (const f of files) {
  const mod = await import(join(HERE, f));
  results.push(await mod.run());
}

console.log('\n──────────────────────────────────────────────');
for (const r of results) {
  const mark = r.ok ? '✔ PASS' : r.modelFault ? '~ MODEL' : '✘ FAIL';
  console.log(`${mark}  ${r.name}  (${r.secs}s)${r.ok ? '' : ` — ${String(r.error).split('\n')[0]}`}`);
}
const failed = results.filter((r) => !r.ok && !r.modelFault);
const shortfalls = results.filter((r) => r.modelFault);
console.log(`──────────────────────────────────────────────`);
console.log(`${results.length - failed.length - shortfalls.length} passed, ${failed.length} app failures, `
  + `${shortfalls.length} model shortfalls`);
if (shortfalls.length && !failed.length) {
  console.log('The app did its part everywhere; the model did not produce what was asked for above.');
}
process.exit(failed.length ? 1 : 0);
