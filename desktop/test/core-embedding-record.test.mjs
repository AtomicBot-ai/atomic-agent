// Unit tests for the embedding side under Atomic Chat Core (main/agent-cli.ts,
// main/backend-switch.ts), against the built output.
// Run: npm run build && npm run test:unit
// EmbeddingGemma 2 runs in Core's embedding module, recorded as
// core/embedding-module.json with no pid file of ours: a stop before a
// Remove must still reach it through `models stop-embedding`.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const home = mkdtempSync(join(tmpdir(), "core-embedding-record-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const cli = require("../out/main/agent-cli.js");
const switcher = require("../out/main/backend-switch.js");

function dataDir(name, files) {
  const dir = join(home, name);
  mkdirSync(join(dir, "core"), { recursive: true });
  for (const f of files) writeFileSync(join(dir, "core", f), "{}");
  return dir;
}

test("Core's embedding module counts as a Core-held embedding server, like an embedding session", () => {
  assert.equal(cli.coreEmbeddingRecorded(dataDir("module", ["embedding-module.json"])), true);
  assert.equal(cli.coreEmbeddingRecorded(dataDir("session", ["embedding.json"])), true);
  assert.equal(cli.coreEmbeddingRecorded(dataDir("chat-only", ["chat.json"])), false);
  assert.equal(cli.coreEmbeddingRecorded(dataDir("none", [])), false);
});

test("a switch sees the embedding module as a Core session still recorded", () => {
  assert.equal(switcher.coreSessionsRecorded(dataDir("module-2", ["embedding-module.json"])), true);
  assert.equal(switcher.coreSessionsRecorded(dataDir("none-2", [])), false);
});
