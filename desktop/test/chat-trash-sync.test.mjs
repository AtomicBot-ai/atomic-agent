// Unit tests for ATO-2474: the window's Trash follows the agent's mark
// (main/chat-trash-sync.ts, against the built output).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const S = require("../out/main/chat-trash-sync.js");
const M = require("../out/main/chat-trash.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 28, 12);
const row = (id, trashed, trashedAt = null, title = id.toUpperCase()) => ({ id, title, trashed, trashedAt });
const okStamp = (log) => async (id) => { log.push(id); return null; };

test("agentTrashRows reads the list, and gives up on an agent whose rows carry no trashed", () => {
  assert.deepEqual(S.agentTrashRows({ sessions: [{ id: "a", title: "A", trashed: true, trashedAt: 5 }, { id: "b", trashed: false, trashedAt: null }, null, { id: "" }] }),
    [row("a", true, 5, "A"), { id: "b", title: "", trashed: false, trashedAt: null }]);
  assert.equal(S.agentTrashRows({ sessions: [{ id: "a", title: "A" }] }), null);
  assert.equal(S.agentTrashRows(null), null);
  assert.equal(S.agentTrashRows({ error: "x" }), null);
});

test("first run: every entry the agent lists unmarked is stamped, and none is dropped", async () => {
  const stamped = [];
  const entries = [{ id: "a", title: "A", deletedAt: NOW - DAY }, { id: "b", title: "B", deletedAt: NOW - 2 * DAY }];
  const out = await S.followAgentTrash(entries, [row("a", false), row("b", true, NOW - 2 * DAY)], { migrated: false, now: NOW, stamp: okStamp(stamped) });
  assert.deepEqual(stamped, ["a"]);
  assert.equal(out.migrated, true);
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(out.entries.map((e) => e.id), ["a", "b"]);
});

test("first run with a failed stamp is not done, and drops nothing", async () => {
  const entries = [{ id: "a", title: "A", deletedAt: NOW }];
  const out = await S.followAgentTrash(entries, [row("a", false)], { migrated: false, now: NOW, stamp: async () => "agent busy" });
  assert.equal(out.migrated, false);
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(out.entries.map((e) => e.id), ["a"]);
});

test("after the first run: a chat restored in the terminal leaves Trash; one trashed elsewhere joins with the agent's date", async () => {
  const entries = [{ id: "a", title: "A", deletedAt: NOW - DAY, pinned: true }, { id: "gone", title: "G", deletedAt: NOW - DAY }];
  const stamped = [];
  const out = await S.followAgentTrash(entries, [row("a", false), row("c", true, NOW - 3 * DAY, "Chat C")], { migrated: true, now: NOW, stamp: okStamp(stamped) });
  assert.deepEqual(stamped, [], "nothing is stamped once the run is done");
  assert.deepEqual(out.dropped, ["a"]);
  assert.deepEqual(out.adopted, ["c"]);
  assert.deepEqual(out.entries, [{ id: "gone", title: "G", deletedAt: NOW - DAY }, { id: "c", title: "Chat C", deletedAt: NOW - 3 * DAY }],
    "a chat the agent does not list stays as the window has it");
});

test("an entry the agent still marks keeps its place fields", async () => {
  const entries = [{ id: "a", title: "A", deletedAt: NOW, archived: true, folder: "f1" }];
  const out = await S.followAgentTrash(entries, [row("a", true, NOW)], { migrated: true, now: NOW, stamp: okStamp([]) });
  assert.deepEqual(out.entries, entries);
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(out.adopted, []);
});

test("followAgent saves the list and the marker, and leaves both alone for an agent it cannot follow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-trash-sync-"));
  try {
    const file = join(dir, "chat-trash.json");
    const marker = join(dir, "chat-trash-agent.json");
    M.writeTrash(file, [{ id: "a", title: "A", deletedAt: NOW - DAY }]);
    const old = await S.followAgent({ sessions: async () => ({ sessions: [{ id: "a", title: "A" }] }) }, file, marker, okStamp([]), NOW);
    assert.equal(old, null);
    assert.equal(S.readMigrated(marker), false);
    const down = await S.followAgent({ sessions: async () => { throw new Error("offline"); } }, file, marker, okStamp([]), NOW);
    assert.equal(down, null);

    const stamped = [];
    const first = await S.followAgent({ sessions: async () => ({ sessions: [row("a", false)] }) }, file, marker, okStamp(stamped), NOW);
    assert.deepEqual(stamped, ["a"]);
    assert.equal(first.migrated, true);
    assert.equal(S.readMigrated(marker), true);
    assert.deepEqual(M.readTrash(file).map((e) => e.id), ["a"]);

    const later = await S.followAgent({ sessions: async () => ({ sessions: [row("a", false)] }) }, file, marker, okStamp([]), NOW);
    assert.deepEqual(later.dropped, ["a"]);
    assert.deepEqual(M.readTrash(file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMigrated is false for a missing or broken marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-trash-sync-"));
  try {
    assert.equal(S.readMigrated(join(dir, "none.json")), false);
    writeFileSync(join(dir, "bad.json"), "{nope");
    assert.equal(S.readMigrated(join(dir, "bad.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: chatTrash:list follows the agent inside the queue", () => {
  const ipc = src("../main/chat-trash-ipc.ts");
  assert.match(ipc, /import \{ followAgent \} from "\.\/chat-trash-sync\.js";/);
  assert.match(ipc, /const follow = \(\) => inQueue\(\(\) => followAgent\(client, trashPath\(\), migratedPath\(\), \(id\) => stamp\(id, true\)\)\);/);
  assert.match(ipc, /"deleteSession" \| "sessionRoute" \| "sessions"/);
});
