import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { daemonPidsIn } = require('../out/main/agent-cli.js');
test('Core children count for model liveness but never enter the legacy kill list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-pids-'));
  try {
    mkdirSync(join(dir, 'core'));
    writeFileSync(join(dir, 'core', 'chat.json'), '{}');
    writeFileSync(join(dir, 'llama-server.pid'), String(process.pid));
    assert.deepEqual(daemonPidsIn(dir), []);
    assert.deepEqual(daemonPidsIn(dir, true), [process.pid]);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
