import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import {
  assistantReplyTurn,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";
import { compactionBoundaryHash, type SessionCompaction } from "./session-compaction.js";
import { pruneSessions } from "./session-retention.js";
import { createEmptySessionState, recordTurn, type SessionState } from "./session-state.js";
import { SessionStore } from "./session-store.js";
import { ARCHIVED_TURNS_KEY, TURN_ARCHIVE_TABLE } from "./turn-archive.js";

/**
 * ATO-1271: turns a compaction covers move out of the session row into
 * `session_turn_archive`, so a write no longer stringifies the whole
 * transcript. Loads still return the full transcript with its original
 * indices.
 */

function conversation(pairs: number, at = 1): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < pairs; i++) {
    turns.push(userTurn(`question ${i}`, at + i * 2));
    turns.push(assistantReplyTurn(`answer ${i}`, at + i * 2 + 1));
  }
  return turns;
}

function compactedAt(turns: readonly ConversationTurn[], through: number): SessionCompaction {
  return {
    version: 1,
    summary: "Earlier: questions and answers.",
    coveredThrough: through,
    boundaryHash: compactionBoundaryHash(turns[through - 1]!),
    createdAt: 1,
    reason: "threshold",
    model: null,
    kind: "extractive",
    tokensBefore: 100,
    tokensAfter: 10,
  };
}

function session(id: string, turns: ConversationTurn[], through?: number): SessionState {
  return {
    ...createEmptySessionState({ id, workingDir: "/w" }),
    turns,
    turnCount: turns.length / 2,
    status: "completed",
    updatedAt: 5_000,
    ...(through === undefined ? {} : { compaction: compactedAt(turns, through) }),
  };
}

describe("SessionStore turn archive", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-turn-archive-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function rawPayload(id: string): Record<string, unknown> {
    const row = store
      .getDatabaseHandleForRetention()
      .prepare(`SELECT payload FROM sessions WHERE id = ?`)
      .get(id) as { payload: string };
    return JSON.parse(row.payload) as Record<string, unknown>;
  }

  function archivedRows(id: string): number[] {
    return (
      store
        .getDatabaseHandleForRetention()
        .prepare(`SELECT idx FROM ${TURN_ARCHIVE_TABLE} WHERE session_id = ? ORDER BY idx`)
        .all(id) as { idx: number }[]
    ).map((row) => row.idx);
  }

  it("keeps a session without a checkpoint in the row, exactly as before", () => {
    const state = session("plain", conversation(3));
    store.save(state);
    const payload = rawPayload("plain");
    expect(payload.turns).toEqual(state.turns);
    expect(payload).not.toHaveProperty(ARCHIVED_TURNS_KEY);
    expect(archivedRows("plain")).toEqual([]);
  });

  it("moves the covered turns out of the payload and loads the full transcript back", () => {
    const turns = conversation(5);
    const state = session("s1", turns, 6);
    store.save(state);

    const payload = rawPayload("s1");
    expect(payload.turns).toEqual(turns.slice(6));
    expect(payload[ARCHIVED_TURNS_KEY]).toEqual({ count: 6, firstUserText: "question 0" });
    expect(archivedRows("s1")).toEqual([0, 1, 2, 3, 4, 5]);

    const loaded = store.load("s1");
    expect(loaded?.turns).toEqual(turns);
    expect(loaded).not.toHaveProperty(ARCHIVED_TURNS_KEY);
    // The checkpoint still matches the transcript, so it survives the load.
    expect(loaded?.compaction?.coveredThrough).toBe(6);
    expect(loaded?.compactionWarning).toBeUndefined();
    expect(store.listRecent(5).find((s) => s.id === "s1")?.turns).toEqual(turns);
    expect(store.listByWorkingDir("/w", 5).find((s) => s.id === "s1")?.turns).toEqual(turns);
  });

  it("writes each archived turn once and only adds the newly covered ones", () => {
    const turns = conversation(4);
    store.save(session("s2", turns, 4));
    const db = store.getDatabaseHandleForRetention();
    db.exec(
      `CREATE TEMP TABLE archive_writes (idx INTEGER);
       CREATE TEMP TRIGGER count_archive_writes AFTER INSERT ON ${TURN_ARCHIVE_TABLE}
       BEGIN INSERT INTO archive_writes (idx) VALUES (NEW.idx); END;`,
    );

    // More turns, same checkpoint: nothing new is archived.
    let next = recordTurn(session("s2", turns, 4), userTurn("one more", 100));
    store.save(next);
    expect(db.prepare(`SELECT idx FROM archive_writes`).all()).toEqual([]);

    // The checkpoint moves on: only the turns between the two are written.
    next = recordTurn(next, assistantReplyTurn("done", 101));
    next = { ...next, compaction: compactedAt(next.turns, 8) };
    store.save(next);
    expect(db.prepare(`SELECT idx FROM archive_writes ORDER BY idx`).all()).toEqual([
      { idx: 4 },
      { idx: 5 },
      { idx: 6 },
      { idx: 7 },
    ]);
    expect(store.load("s2")?.turns).toEqual(next.turns);
  });

  it("keeps the archive when a later copy drops the checkpoint but keeps the history", () => {
    const turns = conversation(4);
    store.save(session("s3", turns, 4));
    const { compaction: _dropped, ...withoutCheckpoint } = session("s3", turns, 4);
    store.save(withoutCheckpoint);
    expect(rawPayload("s3")[ARCHIVED_TURNS_KEY]).toEqual({ count: 4, firstUserText: "question 0" });
    expect(store.load("s3")?.turns).toEqual(turns);
  });

  it("stores an older, shorter copy in full and drops the archive it no longer matches", () => {
    const turns = conversation(5);
    store.save(session("s4", turns, 8));
    const older = session("s4", turns.slice(0, 4));
    store.save(older);
    expect(archivedRows("s4")).toEqual([]);
    expect(rawPayload("s4")).not.toHaveProperty(ARCHIVED_TURNS_KEY);
    expect(store.load("s4")?.turns).toEqual(older.turns);
  });

  it("stores a rewritten history in full when its archived prefix no longer matches", () => {
    const turns = conversation(4);
    store.save(session("s5", turns, 4));
    const rewritten = conversation(4, 1_000);
    store.save(session("s5", rewritten));
    expect(archivedRows("s5")).toEqual([]);
    expect(store.load("s5")?.turns).toEqual(rewritten);
  });

  it("still loads a row written before the archive existed", () => {
    const turns = conversation(3);
    const old = session("legacy", turns, 2);
    const raw = new DatabaseCtor(file);
    try {
      raw
        .prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES (?, '/w', 'completed', ?, 1, 5000)`,
        )
        .run("legacy", JSON.stringify(old));
    } finally {
      raw.close();
    }
    const loaded = store.load("legacy");
    expect(loaded?.turns).toEqual(turns);
    expect(loaded?.compaction?.coveredThrough).toBe(2);
    // Migrated on its next write.
    store.save(loaded!);
    expect(archivedRows("legacy")).toEqual([0, 1]);
    expect(store.load("legacy")?.turns).toEqual(turns);
  });

  it("reads chat lines and the list row's opening prompt across the archive", () => {
    const turns = conversation(3);
    store.save(session("s6", turns, 4));
    expect(store.listChatLines("s6")).toEqual(
      turns.map((turn) => ({ kind: turn.kind, text: (turn as { text: string }).text })),
    );
    const row = store.listSummaryPage({ limit: 10 }).find((s) => s.id === "s6");
    expect(row?.firstPrompt).toBe("question 0");
  });

  it("removes the archived turns with the session", () => {
    store.save(session("gone", conversation(3), 4));
    expect(archivedRows("gone")).toHaveLength(4);
    store.delete("gone");
    expect(archivedRows("gone")).toEqual([]);
  });

  it("removes the archived turns of sessions the retention pass deletes", () => {
    store.save({ ...session("old", conversation(3), 4), updatedAt: 1 });
    expect(archivedRows("old")).toHaveLength(4);
    pruneSessions({
      db: store.getDatabaseHandleForRetention(),
      maxAgeDays: 1,
      maxRows: null,
      now: 10 * 24 * 60 * 60 * 1000,
    });
    expect(store.load("old")).toBeNull();
    expect(archivedRows("old")).toEqual([]);
  });
});
