import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../renderer/disk-space.js');
const M = require('../out/main/disk-space.js');

// ATO-507: a model download is checked against the free space on the models disk.

const GB = 1024 ** 3;

test('sizes read as the catalogue writes them: "19.7 GB", MB, a bare GB number, bytes', () => {
  assert.equal(R.diskSizeBytes('19.7 GB'), 19.7 * GB);
  assert.equal(R.diskSizeBytes('635 MB'), 635 * 1024 ** 2);
  assert.equal(R.diskSizeBytes('1 TiB'), 1024 * GB);
  assert.equal(R.diskSizeBytes('5.3'), 5.3 * GB);
  assert.equal(R.diskSizeBytes(123456789), 123456789);
  assert.equal(R.diskSizeBytes(''), 0);
  assert.equal(R.diskSizeBytes(null), 0);
  assert.equal(R.diskSizeBytes('about twenty'), 0);
  assert.equal(R.diskSizeBytes(-5), 0);
  assert.equal(R.diskSizeBytes(NaN), 0);
});

test('a download that does not fit says how much it needs and how much is free', () => {
  const fit = R.diskFit('19.7 GB', {freeBytes: 12.15 * GB});
  assert.equal(fit.ok, false);
  assert.equal(fit.text, 'Needs 19.7 GB, 12.1 GB free on this disk.');
});

test('free space is rounded down, never said to be more than it is', () => {
  assert.equal(R.diskGbWord(12.19 * GB, true), '12.1 GB');
  assert.equal(R.diskGbWord(19.66 * GB), '19.7 GB');
  assert.equal(R.diskGbWord(20 * GB), '20 GB');
});

test('the margin: the file alone fitting is not enough', () => {
  // 10 GB wants 11 GB free with the default 10%.
  assert.equal(R.diskFit(10 * GB, {freeBytes: 11.1 * GB}).ok, true);
  const close = R.diskFit(10 * GB, {freeBytes: 10.5 * GB});
  assert.equal(close.ok, false);
  assert.equal(close.text, 'Needs 10 GB and some room to spare, 10.5 GB free on this disk.');
  // A margin of its own.
  assert.equal(R.diskFit(10 * GB, {freeBytes: 10.5 * GB}, 0, 0).ok, true);
  assert.equal(R.DISK_MARGIN, 0.1);
});

test('a vision model counts its projector', () => {
  assert.equal(R.diskFit('9 GB', {freeBytes: 10.5 * GB}).ok, true);
  const fit = R.diskFit('9 GB', {freeBytes: 10.5 * GB}, '1 GB');
  assert.equal(fit.ok, false);
  assert.match(fit.text, /^Needs 10 GB/);
});

test('unknown free space or an unknown size never blocks a download', () => {
  assert.deepEqual(R.diskFit('19.7 GB', null), {ok: true});
  assert.deepEqual(R.diskFit('19.7 GB', undefined), {ok: true});
  assert.deepEqual(R.diskFit('19.7 GB', {}), {ok: true});
  assert.deepEqual(R.diskFit('19.7 GB', {freeBytes: 'n/a'}), {ok: true});
  assert.deepEqual(R.diskFit('19.7 GB', {freeBytes: -1}), {ok: true});
  assert.deepEqual(R.diskFit('', {freeBytes: 1}), {ok: true});
  assert.deepEqual(R.diskFit(0, {freeBytes: 0}), {ok: true});
});

test('the reading is cached: re-read when forced or when stale, one read at a time', async () => {
  let reads = 0;
  let changes = 0;
  const br = {diskSpace: async () => { reads++; return {freeBytes: (reads === 1 ? 50 : 10) * GB, totalBytes: 500 * GB, path: '/x'}; }};
  R.DISK.onChange = () => { changes++; };
  const t0 = 1_000_000;
  const [a, b] = await Promise.all([R.diskSpaceRefresh(br, true, t0), R.diskSpaceRefresh(br, true, t0)]);
  assert.equal(reads, 1);
  assert.equal(a.freeBytes, 50 * GB);
  assert.equal(b, a);
  assert.equal(changes, 1);
  await R.diskSpaceRefresh(br, false, t0 + 5_000);
  assert.equal(reads, 1, 'fresh enough: no read');
  await R.diskSpaceRefresh(br, false, t0 + R.DISK_STALE_MS + 1);
  assert.equal(reads, 2, 'stale: read again');
  assert.equal(R.DISK.space.freeBytes, 10 * GB);
  assert.equal(changes, 2);
  // A bridge that fails keeps the last reading and does not throw.
  const bad = {diskSpace: async () => { throw new Error('nope'); }};
  assert.equal((await R.diskSpaceRefresh(bad, true, t0 + 100_000)).freeBytes, 10 * GB);
  // An answer of null (main could not read the disk) is unknown: nothing blocks.
  await R.diskSpaceRefresh({diskSpace: async () => null}, true, t0 + 200_000);
  assert.equal(R.DISK.space, null);
  assert.equal(R.diskFit('19.7 GB', R.DISK.space).ok, true);
  R.DISK.onChange = null;
});

test('index.html loads disk-space.js before renderer.js', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="disk-space.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
});

test('main measures the nearest folder that exists above the models folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'disk-space-'));
  try {
    const space = await M.diskSpaceAt(join(root, 'models', 'models'));
    assert.ok(space);
    assert.equal(space.path, root);
    assert.ok(space.freeBytes >= 0 && space.totalBytes > 0);
    assert.equal(M.modelsDirOf('/a/b'), join('/a/b', 'models'));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('main answers null when the disk cannot be read', async () => {
  const eacces = Object.assign(new Error('denied'), {code: 'EACCES'});
  assert.equal(await M.diskSpaceAt('/x/y', {statfs: async () => { throw eacces; }}), null);
  const enoent = Object.assign(new Error('gone'), {code: 'ENOENT'});
  assert.equal(await M.diskSpaceAt('/x/y', {statfs: async () => { throw enoent; }}), null);
  assert.deepEqual(await M.diskSpaceAt('/x/y', {statfs: async () => ({bavail: 10, bsize: 4096, blocks: 100})}),
    {freeBytes: 40960, totalBytes: 409600, path: '/x/y'});
});
