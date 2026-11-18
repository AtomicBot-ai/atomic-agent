// ATO-921: the window froze on Windows (WindowUnresponsive) while the main
// process waited for a synchronous PowerShell. The probes on paths the window
// waits on are asynchronous now.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { commandOfAsync, reapOrphanedServeAsync } = require("../out/main/agent-client.js");

test("commandOfAsync answers this process's command line, and null for a dead pid", async () => {
  const mine = await commandOfAsync(process.pid);
  assert.equal(typeof mine, "string");
  assert.ok(mine.length > 0);
  assert.equal(await commandOfAsync(2 ** 22 + 12345), null);
});

test("reapOrphanedServeAsync forgets a record whose pid is not our serve, and kills nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atag-reap-"));
  try {
    const path = join(dir, "serve.json");
    // This test process is alive but is not `atag serve` on that port.
    writeFileSync(path, JSON.stringify({ pid: process.pid, port: 1, startedAt: Date.now() }));
    assert.equal(await reapOrphanedServeAsync(path), null);
    assert.equal(existsSync(path), false);
    // Garbage and a missing record are both nothing to reap.
    writeFileSync(path, "not json");
    assert.equal(await reapOrphanedServeAsync(path), null);
    assert.equal(await reapOrphanedServeAsync(join(dir, "missing.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reapOrphanedServeAsync leaves a child this client still owns alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atag-reap-"));
  try {
    const path = join(dir, "serve.json");
    writeFileSync(path, JSON.stringify({ pid: process.pid, port: 1, startedAt: Date.now() }));
    assert.equal(await reapOrphanedServeAsync(path, new Set([process.pid])), null);
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent start and the quit-time cleanup no longer call the synchronous probe", () => {
  const client = readFileSync(new URL("../main/agent-client.ts", import.meta.url), "utf8");
  assert.match(client, /await reapOrphanedServeAsync\(this\.recordPath, own\)/);
  const cli = readFileSync(new URL("../main/agent-cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /[^A-Za-z]commandOf\(/);
  assert.match(cli, /export async function killDaemonLeftovers/);
});
