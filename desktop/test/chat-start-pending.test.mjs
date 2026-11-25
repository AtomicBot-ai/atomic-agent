// Unit tests for main/chat-start-pending.ts (ATO-421), against the built output.
// Run: npm run build && npm run test:unit
// The supervisor's restart marks a chat start as on its way in the agent's
// models folder, so a turn waiting on the refused port does not end while
// the restart's `models start` is still booting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { markChatStartPending, CHAT_START_PENDING_FILE } = require("../out/main/chat-start-pending.js");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-start-pending-"));
  return { dir, path: join(dir, CHAT_START_PENDING_FILE), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the marker is the agent's file name and holds the app's pid until the restart ends", () => {
  const s = scratch();
  try {
    assert.equal(CHAT_START_PENDING_FILE, "chat-start.pending");
    const undo = markChatStartPending(s.dir);
    assert.equal(readFileSync(s.path, "utf8"), String(process.pid));
    undo();
    assert.equal(existsSync(s.path), false);
  } finally {
    s.done();
  }
});

test("a models start that took the marker over keeps it", () => {
  const s = scratch();
  try {
    const undo = markChatStartPending(s.dir);
    writeFileSync(s.path, "4242");
    undo();
    assert.equal(readFileSync(s.path, "utf8"), "4242");
  } finally {
    s.done();
  }
});

test("a folder that cannot be written never fails the restart", () => {
  const undo = markChatStartPending(join(tmpdir(), "no-such-dir-ato-421", "models"));
  assert.doesNotThrow(() => undo());
});
