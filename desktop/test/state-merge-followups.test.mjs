// ATO-418: follow-ups to the one-time merge of ~/.atomic-agent-desktop into
// the shared ~/.atomic-agent (main/state-migrate.ts, main/copied-db-cleanup.ts),
// against the built output (npm run build first). Everything runs on
// throwaway directories; nothing of the operator's is read or written.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const M = require("../out/main/state-migrate.js");
const C = require("../out/main/copied-db-cleanup.js");

const root = mkdtempSync(join(tmpdir(), "ato418-merge-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => join(root, `${name}-${n++}`);

const put = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

function makeLegacy(dir) {
  put(join(dir, "config.json"), JSON.stringify({ llm: { providers: [] } }));
}

const deps = (over = {}) => ({
  runAtag: () => ({ status: 1, stdout: "", stderr: "no agent in this test" }),
  reapServe: () => {},
  pidAlive: () => false,
  now: () => 1_760_000_000_000 + n++,
  ...over,
});

/* ---- item 1: an env naming the shared directory itself ---- */

test("an env that names the shared directory itself does not hold the merge back", () => {
  const legacy = fresh("legacy");
  const shared = fresh("shared");
  makeLegacy(legacy);
  mkdirSync(shared, { recursive: true });
  const gate = (over) => M.mergeGate({ currentDir: shared, sharedDir: shared, legacyDir: legacy, fromEnv: false, ...over });
  assert.equal(gate({}).run, true);
  assert.equal(gate({ fromEnv: true }).run, true, "env == shared dir");
  assert.equal(gate({ fromEnv: true, currentDir: `${shared}/` }).run, true, "trailing slash");
  const other = gate({ fromEnv: true, currentDir: fresh("elsewhere") });
  assert.equal(other.run, false);
  assert.match(other.reason, /named by the environment/);
});

test("sameStateDir: trailing separators, a leading ~ and a symlinked spelling name one folder", () => {
  const home = fresh("home");
  const shared = join(home, ".atomic-agent");
  mkdirSync(shared, { recursive: true });
  assert.equal(M.sameStateDir(`${shared}/`, shared, home), true);
  assert.equal(M.sameStateDir(`${shared}//`, shared, home), true);
  assert.equal(M.sameStateDir("~/.atomic-agent", shared, home), true);
  assert.equal(M.sameStateDir("~/.atomic-agent/", shared, home), true);
  if (process.platform !== "win32") {
    const link = join(root, `link-${n++}`);
    symlinkSync(shared, link);
    assert.equal(M.sameStateDir(link, shared, home), true);
  }
  assert.equal(M.sameStateDir(join(home, ".atomic-agent-other"), shared, home), false);
  assert.equal(M.sameStateDir("~/.atomic-agent-desktop", shared, home), false);
});

/* ---- item 2: the merge lock and a reused pid ---- */

function lockedTarget(lockText) {
  const legacy = fresh("legacy");
  const shared = fresh("shared");
  makeLegacy(legacy);
  put(join(shared, ".desktop-merge.lock"), lockText);
  return { legacy, shared };
}

test("a merge lock whose pid now belongs to another process (start differs) is stale", () => {
  const { legacy, shared } = lockedTarget("999991\nlstart:Mon Jan 1 00:00:00 2024\n");
  const out = M.migrateDesktopState(legacy, shared, deps({
    pidAlive: (pid) => pid === 999991,
    processStartOf: (pid) => (pid === 999991 ? "lstart:Tue Oct 20 09:00:00 2026" : null),
  }));
  assert.equal(out.ran, true, JSON.stringify(out));
  assert.equal(out.record.ok, true, out.record.error);
});

test("a merge lock held by the same live process (start matches) still holds", () => {
  const start = "lstart:Tue Oct 20 09:00:00 2026";
  const { legacy, shared } = lockedTarget(`999992\n${start}\n`);
  const out = M.migrateDesktopState(legacy, shared, deps({ pidAlive: () => true, processStartOf: () => start }));
  assert.equal(out.ran, false);
  assert.match(out.reason, /another launch \(pid 999992\)/);
});

test("without a recorded start, or where a start cannot be read (Windows), the pid alone decides as before", () => {
  const bare = lockedTarget("999993");
  const a = M.migrateDesktopState(bare.legacy, bare.shared, deps({ pidAlive: () => true, processStartOf: () => "lstart:x" }));
  assert.equal(a.ran, false);
  const unknown = lockedTarget("999994\nlstart:old\n");
  const b = M.migrateDesktopState(unknown.legacy, unknown.shared, deps({ pidAlive: () => true, processStartOf: () => null }));
  assert.equal(b.ran, false);
});

test("the lock this launch writes records its own start next to its pid", () => {
  const legacy = fresh("legacy");
  const shared = fresh("shared");
  makeLegacy(legacy);
  let seen = null;
  const out = M.migrateDesktopState(legacy, shared, deps({
    processStartOf: (pid) => (pid === process.pid ? "ticks:12345" : null),
    reapServe: () => { seen = readFileSync(join(shared, ".desktop-merge.lock"), "utf8"); },
  }));
  assert.equal(out.ran, true);
  assert.equal(seen, `${process.pid}\nticks:12345\n`);
  assert.equal(existsSync(join(shared, ".desktop-merge.lock")), false, "released");
});

/* ---- item 3: the notice ---- */

const record = (over = {}, counts = {}) => ({
  ok: true, mode: "copy", at: "2026-10-23T00:00:00.000Z", attempts: 1,
  legacyDir: "/somewhere/.atomic-agent-desktop", targetDir: "/somewhere/.atomic-agent", backupDir: null,
  counts: {
    providersAdded: 0, keysFilled: 0, mcpServersAdded: 0, customModelsAdded: 0, envKeysAdded: 0,
    databasesCopied: [], skillsCopied: 0, filesCopied: 0, tracesMoved: 0, modelsMoved: 0, ...counts,
  },
  imported: null, warnings: [], noticeShown: false, ...over,
});

test("a copy that moved weights or traces does not call the old folder a backup", () => {
  const t = M.stateMergeNoticeFor(record({}, { modelsMoved: 2, tracesMoved: 5 })).text;
  assert.doesNotMatch(t, /backup/i);
  assert.match(t, /still in \/somewhere\/\.atomic-agent-desktop, except the model files and traces, which were moved to \/somewhere\/\.atomic-agent\./);
  assert.doesNotMatch(t, /—/);
  const onlyTraces = M.stateMergeNoticeFor(record({}, { tracesMoved: 1 })).text;
  assert.match(onlyTraces, /except the traces, which were moved/);
});

test("a copy that moved nothing out may still call the old folder a backup; a merge names its own backup", () => {
  assert.match(M.stateMergeNoticeFor(record()).text, /A backup of the earlier files is in \/somewhere\/\.atomic-agent-desktop\./);
  const merged = M.stateMergeNoticeFor(record({ mode: "merge", backupDir: "/somewhere/.atomic-agent/backups/b1" }, { modelsMoved: 1 })).text;
  assert.match(merged, /A backup of the earlier files is in \/somewhere\/\.atomic-agent\/backups\/b1\./);
});

test("a move that failed is said in the notice, not only in the log", () => {
  const t = M.stateMergeNoticeFor(record({}, { modelsMoved: 1, modelsNotMoved: 2, tracesNotMoved: 1 })).text;
  assert.match(t, /2 model folders and 1 trace could not be moved and are still in \/somewhere\/\.atomic-agent-desktop\. The Diagnostics log has the details\./);
  assert.doesNotMatch(t, /—/);
  const one = M.stateMergeNoticeFor(record({}, { modelsNotMoved: 1 })).text;
  assert.match(one, /1 model folder could not be moved and is still in /);
  const none = M.stateMergeNoticeFor(record({}, { modelsMoved: 1 })).text;
  assert.doesNotMatch(none, /could not be moved/);
  // A marker written before ATO-418 has no such counts.
  assert.doesNotMatch(M.stateMergeNoticeFor(record()).text, /could not be moved/);
  assert.match(M.stateMergeLogLine(record({}, { modelsNotMoved: 2 })), /2 models not moved/);
});

/* ---- item 4: a database copied as is gets the importer's clean-up ---- */

function makeSessionsDb(file, { withOwner = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, status TEXT, payload TEXT,
           created_at INTEGER, updated_at INTEGER${withOwner ? ", turn_owner TEXT" : ""})`);
  const ins = db.prepare(`INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at${withOwner ? ", turn_owner" : ""})
                          VALUES (?, '/w', ?, ?, 1, 2${withOwner ? ", ?" : ""})`);
  for (const [id, status] of [["s-run", "running"], ["s-appr", "awaiting_approval"], ["s-llm", "awaiting_llm"], ["s-done", "completed"]]) {
    const args = [id, status, JSON.stringify({ id, status, lastError: null })];
    if (withOwner) args.push(status === "completed" ? null : '{"pid":1}');
    ins.run(...args);
  }
  db.close();
}

function makeTasksDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, started_at INTEGER, last_error TEXT,
           last_error_cat TEXT, updated_at INTEGER, run_owner TEXT)`);
  db.prepare("INSERT INTO tasks VALUES ('t-run', 'running', 5, NULL, NULL, 7, '{\"pid\":1}')").run();
  db.prepare("INSERT INTO tasks VALUES ('t-run-err', 'running', 5, 'own error', 'llm', 7, NULL)").run();
  db.prepare("INSERT INTO tasks VALUES ('t-done', 'completed', 5, NULL, NULL, 7, NULL)").run();
  db.close();
}

const rows = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

test("cleanCopiedDatabase ends live chats as interrupted and puts running tasks back to pending", () => {
  const dir = fresh("clean");
  mkdirSync(dir, { recursive: true });
  makeSessionsDb(join(dir, "sessions.sqlite"));
  makeTasksDb(join(dir, "tasks.sqlite"));
  assert.equal(C.cleanCopiedDatabase(join(dir, "sessions.sqlite"), "sessions.sqlite"), 3);
  const s = Object.fromEntries(rows(join(dir, "sessions.sqlite"), "SELECT id, status, payload, turn_owner, updated_at FROM sessions").map((r) => [r.id, r]));
  for (const id of ["s-run", "s-appr", "s-llm"]) {
    assert.equal(s[id].status, "cancelled");
    assert.deepEqual(JSON.parse(s[id].payload), { id, status: "cancelled", lastError: C.INTERRUPTED_TURN_ERROR });
    assert.equal(s[id].turn_owner, null);
    assert.equal(s[id].updated_at, 2, "updated_at kept, as the importer keeps it");
  }
  assert.equal(s["s-done"].status, "completed");
  assert.equal(JSON.parse(s["s-done"].payload).status, "completed");

  assert.equal(C.cleanCopiedDatabase(join(dir, "tasks.sqlite"), "tasks.sqlite"), 2);
  const t = Object.fromEntries(rows(join(dir, "tasks.sqlite"), "SELECT * FROM tasks").map((r) => [r.id, r]));
  assert.deepEqual(
    { status: t["t-run"].status, started: t["t-run"].started_at, err: t["t-run"].last_error, cat: t["t-run"].last_error_cat, owner: t["t-run"].run_owner },
    { status: "pending", started: null, err: C.TASK_OWNER_GONE_ERROR, cat: "transport", owner: null },
  );
  assert.equal(t["t-run-err"].last_error, "own error");
  assert.equal(t["t-run-err"].last_error_cat, "llm");
  assert.equal(t["t-done"].status, "completed");
  assert.equal(C.cleanCopiedDatabase(join(dir, "memory.sqlite"), "memory.sqlite"), 0, "other databases are left alone");
});

test("an older database without turn_owner, or without a tasks table, is cleaned as far as it goes", () => {
  const dir = fresh("old");
  mkdirSync(dir, { recursive: true });
  makeSessionsDb(join(dir, "sessions.sqlite"), { withOwner: false });
  assert.equal(C.cleanCopiedDatabase(join(dir, "sessions.sqlite"), "sessions.sqlite"), 3);
  const empty = new DatabaseSync(join(dir, "tasks.sqlite"));
  empty.exec("CREATE TABLE other (x)");
  empty.close();
  assert.equal(C.cleanCopiedDatabase(join(dir, "tasks.sqlite"), "tasks.sqlite"), 0);
});

test("the merge's copy mode applies the clean-up to the copies and leaves the old databases as they were", () => {
  const legacy = fresh("legacy");
  const shared = fresh("shared");
  makeLegacy(legacy);
  makeSessionsDb(join(legacy, "sessions.sqlite"));
  makeTasksDb(join(legacy, "tasks.sqlite"));
  const out = M.migrateDesktopState(legacy, shared, deps());
  assert.equal(out.ran, true);
  assert.equal(out.record.ok, true, out.record.error);
  assert.deepEqual(out.record.counts.databasesCopied, ["sessions.sqlite", "tasks.sqlite"]);
  assert.equal(out.record.counts.runsEnded, 5);
  assert.deepEqual(rows(join(shared, "sessions.sqlite"), "SELECT status FROM sessions WHERE id = 's-run'"), [{ status: "cancelled" }]);
  assert.deepEqual(rows(join(shared, "tasks.sqlite"), "SELECT status FROM tasks WHERE id = 't-run'"), [{ status: "pending" }]);
  assert.deepEqual(rows(join(legacy, "sessions.sqlite"), "SELECT status FROM sessions WHERE id = 's-run'"), [{ status: "running" }]);
  assert.deepEqual(rows(join(legacy, "tasks.sqlite"), "SELECT status FROM tasks WHERE id = 't-run'"), [{ status: "running" }]);
  assert.equal(existsSync(join(shared, "sessions.sqlite.part")), false);
});
