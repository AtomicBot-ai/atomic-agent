import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stage07-observer-'));
const root = path.join(temporary, 'checkout'), log = path.join(temporary, 'reads.jsonl');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'AGENTS.md'), 'one\nneedle two\nthree\n');
fs.writeFileSync(path.join(temporary, 'outside'), 'private');
fs.symlinkSync(path.join(temporary, 'outside'), path.join(root, 'escape'));
const observer = fileURLToPath(new URL('stage07-read-observer.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [observer, root, log, ...args], { encoding: 'utf8' });
try {
  let result = run('read', 'AGENTS.md', '2', '1');
  assert.equal(result.status, 0); assert.equal(result.stdout, 'needle two\n');
  result = run('search', 'needle', 'AGENTS.md');
  assert.equal(result.status, 0); assert.match(result.stdout, /AGENTS.md:2:needle two/);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0].spans.map(({ start, end }) => [start, end]), [[4, 15]]);
  assert.deepEqual(rows[1].spans.map(({ start, end }) => [start, end]), [[4, 14]]);
  assert.equal(rows[0].outputBytes, Buffer.byteLength(rows[0].output));
  assert.notEqual(run('read', 'escape').status, 0);
  assert.notEqual(run('search', 'private', '../outside').status, 0);
  const badLog = spawnSync(process.execPath, [observer, root, path.join(root, 'log'), 'read', 'AGENTS.md']);
  assert.notEqual(badLog.status, 0);
  console.log('observer: exact read/search spans and output bytes; path escape/log guards passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
