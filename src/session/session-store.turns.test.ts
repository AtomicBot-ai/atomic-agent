import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { userTurn } from "./conversation-turn.js";
import {
  INTERRUPTED_TURN_ENDING,
  SessionStore,
} from "./session-store.js";
import {
  createEmptySessionState,
  incrementTurnCount,
  recordTurn,
  type SessionState,
} from "./session-state.js";
import type { TurnOwnerProbe } from "./turn-owner.js";

/**
 * A turn's life in the store: `beginTurn` marks the row `running` and
 * says which process runs it, and every way the turn ends takes that
 * off — its own end (`finishTurn`), an end without a state
 * (`releaseTurn`, `releaseOwnTurns`), or, when its process is gone, the
 * next boot (`recoverInterruptedTurns`). Before the mark existed a turn
 * cut off before its end left the row as it was before the turn.
 */

const BOOT = 1_790_000_000;

function probe(
  pid: number,
  isAlive: (pid: number) => boolean = () => true,
): TurnOwnerProbe {
  return { pid, bootAt: BOOT, isAlive };
}

interface RawRow {
  status: string;
  turnOwner: string | null;
  updatedAt: number;
  payload: string;
}

describe("SessionStore turn marks", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-turns-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(100) });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function raw(id: string): RawRow | undefined {
    return store
      .getDatabaseHandleForRetention()
      .prepare(
        `SELECT status, turn_owner AS turnOwner, updated_at AS updatedAt, payload
         FROM sessions WHERE id = ?`,
      )
      .get(id) as RawRow | undefined;
  }

  function seed(id: string, extra: Partial<SessionState> = {}): SessionState {
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: "/w" }),
      updatedAt: 5_000,
      ...extra,
    };
    store.save(state);
    return state;
  }

  /** What the loop hands back for a turn: the message recorded, the turn closed. */
  function ended(
    state: SessionState,
    status: SessionState["status"],
  ): SessionState {
    return {
      ...incrementTurnCount(recordTurn(state, userTurn("do the thing"))),
      status,
    };
  }

  it("beginTurn marks the row running, in the column and the payload, and names this process", () => {
    seed("s1");
    expect(store.beginTurn("s1", 7_000)).toBe(true);
    const row = raw("s1");
    expect(row?.status).toBe("running");
    expect(store.load("s1")?.status).toBe("running");
    expect(JSON.parse(row?.turnOwner ?? "null")).toEqual({
      pid: 100,
      bootAt: BOOT,
      at: 7_000,
    });
    // Ordering and the desktop's "unread" both read `updated_at`: a turn
    // starting changes neither.
    expect(row?.updatedAt).toBe(5_000);
    expect(store.load("s1")?.updatedAt).toBe(5_000);
  });

  it("beginTurn writes nothing for a session that has no row yet", () => {
    expect(store.beginTurn("never-saved")).toBe(false);
    expect(raw("never-saved")).toBeUndefined();
  });

  it("finishTurn writes the turn's end and takes the mark off", () => {
    const state = seed("s2");
    store.beginTurn("s2");
    store.finishTurn(ended(state, "pending"));
    const row = raw("s2");
    expect(row?.status).toBe("pending");
    expect(row?.turnOwner).toBeNull();
    const loaded = store.load("s2");
    expect(loaded?.turnCount).toBe(1);
    expect(loaded?.turns.map((t) => t.kind)).toEqual(["user"]);
  });

  it("finishTurn writes the row of a session first saved by its turn", () => {
    // The TUI's deferred session: no row until its first turn ends.
    const state = createEmptySessionState({ id: "deferred", workingDir: "/w" });
    expect(store.beginTurn("deferred")).toBe(false);
    store.finishTurn(ended(state, "cancelled"));
    expect(raw("deferred")?.status).toBe("cancelled");
    expect(raw("deferred")?.turnOwner).toBeNull();
  });

  it("finishTurn keeps a title the turn's state does not carry", () => {
    const state = seed("s-title");
    store.beginTurn("s-title");
    // Named by the previous turn's naming call while this one ran.
    store.save({
      ...state,
      metadata: { ...state.metadata, title: "Named meanwhile" },
    });
    store.finishTurn(ended(state, "pending"));
    expect(store.load("s-title")?.metadata.title).toBe("Named meanwhile");
  });

  it("a plain save during the turn leaves the mark for the turn's end", () => {
    const state = seed("s3");
    store.beginTurn("s3");
    // A model stamp, a wake-reason stamp, a session title: none of them
    // ends the turn.
    store.save({ ...state, metadata: { ...state.metadata, stamped: true } });
    expect(raw("s3")?.turnOwner).not.toBeNull();
    expect(store.releaseTurn("s3", { status: "cancelled" })).toBe(true);
    expect(raw("s3")?.status).toBe("cancelled");
    expect(raw("s3")?.turnOwner).toBeNull();
  });

  it("releaseTurn writes the status and keeps lastError unless it is given one", () => {
    seed("keep", { lastError: "from an earlier turn" });
    store.beginTurn("keep");
    expect(store.releaseTurn("keep", { status: "cancelled" })).toBe(true);
    expect(store.load("keep")?.status).toBe("cancelled");
    expect(store.load("keep")?.lastError).toBe("from an earlier turn");

    seed("replace");
    store.beginTurn("replace");
    expect(
      store.releaseTurn("replace", { status: "failed", lastError: "it threw" }),
    ).toBe(true);
    expect(raw("replace")?.status).toBe("failed");
    expect(store.load("replace")?.status).toBe("failed");
    expect(store.load("replace")?.lastError).toBe("it threw");
    // The transcript is the one from before the turn: there is no other.
    expect(store.load("replace")?.turns).toEqual([]);
  });

  it("releaseTurn does nothing once the turn wrote its own end", () => {
    const state = seed("done");
    store.beginTurn("done");
    store.finishTurn(ended(state, "pending"));
    expect(store.releaseTurn("done", INTERRUPTED_TURN_ENDING)).toBe(false);
    expect(store.load("done")?.status).toBe("pending");
    expect(store.load("done")?.lastError).toBeNull();
  });

  it("releaseTurn leaves a turn another process has since started on the row", () => {
    seed("shared");
    store.beginTurn("shared");
    const other = new SessionStore({
      dbFile: file,
      turnOwnerProbe: probe(200),
    });
    try {
      other.beginTurn("shared");
      expect(store.releaseTurn("shared", INTERRUPTED_TURN_ENDING)).toBe(false);
      expect(raw("shared")?.status).toBe("running");
      expect(JSON.parse(raw("shared")?.turnOwner ?? "null").pid).toBe(200);
    } finally {
      other.close();
    }
  });

  it("releaseOwnTurns ends every turn this store still has marked", () => {
    const finished = seed("finished");
    seed("a");
    seed("b");
    store.beginTurn("finished");
    store.beginTurn("a");
    store.beginTurn("b");
    store.finishTurn(ended(finished, "pending"));
    expect(store.releaseOwnTurns(INTERRUPTED_TURN_ENDING)).toBe(2);
    for (const id of ["a", "b"]) {
      expect(store.load(id)?.status).toBe("cancelled");
      expect(store.load(id)?.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
      expect(raw(id)?.turnOwner).toBeNull();
    }
    expect(store.load("finished")?.status).toBe("pending");
    // Nothing left to release.
    expect(store.releaseOwnTurns(INTERRUPTED_TURN_ENDING)).toBe(0);
  });

  describe("recoverInterruptedTurns", () => {
    /** A turn another process started on `id` and never ended. */
    function markedBy(pid: number, id: string): void {
      seed(id);
      const other = new SessionStore({
        dbFile: file,
        turnOwnerProbe: probe(pid),
      });
      try {
        expect(other.beginTurn(id)).toBe(true);
      } finally {
        // Closing is not ending: that process died mid-turn.
        other.close();
      }
    }

    it("ends a turn whose process is gone, and leaves one a live process owns", () => {
      markedBy(300, "dead-owner");
      markedBy(400, "live-owner");
      const sweeper = new SessionStore({
        dbFile: file,
        turnOwnerProbe: probe(500, (pid) => pid === 400),
      });
      try {
        expect(sweeper.recoverInterruptedTurns()).toEqual(["dead-owner"]);
      } finally {
        sweeper.close();
      }
      const dead = store.load("dead-owner");
      expect(dead?.status).toBe("cancelled");
      expect(dead?.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
      expect(raw("dead-owner")?.turnOwner).toBeNull();
      // Its last activity was before the turn; recording how it ended
      // does not move it up any list.
      expect(raw("dead-owner")?.updatedAt).toBe(5_000);
      expect(store.load("live-owner")?.status).toBe("running");
      expect(raw("live-owner")?.turnOwner).not.toBeNull();
    });

    it("ends a running row nothing claims", () => {
      // A copy read mid-turn and saved after the turn ended writes
      // `running` with no mark behind it.
      seed("unclaimed", { status: "running" });
      expect(raw("unclaimed")?.turnOwner).toBeNull();
      expect(store.recoverInterruptedTurns()).toEqual(["unclaimed"]);
      expect(store.load("unclaimed")?.status).toBe("cancelled");
    });

    it("by default judges marks against this store's process", () => {
      markedBy(100, "same-pid");
      // Same pid as the sweeping store: an earlier process with the
      // same number, never a live turn of this one.
      const sweeper = new SessionStore({
        dbFile: file,
        turnOwnerProbe: probe(100),
      });
      try {
        expect(sweeper.recoverInterruptedTurns()).toEqual(["same-pid"]);
      } finally {
        sweeper.close();
      }
    });

    it("never touches a turn this store is running itself", () => {
      seed("mine");
      store.beginTurn("mine");
      expect(store.recoverInterruptedTurns({ isOwnerGone: () => true })).toEqual(
        [],
      );
      expect(store.load("mine")?.status).toBe("running");
    });

    it("leaves rows that claim no live turn alone", () => {
      seed("idle");
      seed("stopped", { status: "cancelled" });
      seed("broke", { status: "failed", lastError: "x" });
      expect(store.recoverInterruptedTurns({ isOwnerGone: () => true })).toEqual(
        [],
      );
      expect(store.load("idle")?.status).toBe("pending");
      expect(store.load("broke")?.lastError).toBe("x");
    });

    it("moves the status column of a row whose payload is not JSON", () => {
      const db = new DatabaseCtor(file);
      try {
        db.prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES ('corrupt', '/w', 'running', '{not json', 1, 1)`,
        ).run();
      } finally {
        db.close();
      }
      expect(store.recoverInterruptedTurns()).toEqual(["corrupt"]);
      expect(raw("corrupt")?.status).toBe("cancelled");
      expect(raw("corrupt")?.payload).toBe("{not json");
    });

    it("takes a custom ending", () => {
      markedBy(300, "custom");
      const sweeper = new SessionStore({
        dbFile: file,
        turnOwnerProbe: probe(500, () => false),
      });
      try {
        sweeper.recoverInterruptedTurns({
          ending: { status: "failed", lastError: "custom" },
        });
      } finally {
        sweeper.close();
      }
      expect(store.load("custom")?.status).toBe("failed");
      expect(store.load("custom")?.lastError).toBe("custom");
    });
  });
});

describe("SessionStore on a database from before turn marks", () => {
  it("adds the column, keeps every row readable, and marks turns on it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "atomic-agent-turns-old-"));
    const file = join(tmp, "sessions.sqlite");
    try {
      // The schema as every earlier release created it.
      const db = new DatabaseCtor(file);
      try {
        db.exec(`
          CREATE TABLE sessions (
            id           TEXT PRIMARY KEY,
            working_dir  TEXT NOT NULL,
            status       TEXT NOT NULL,
            payload      TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
          );
        `);
        const old = createEmptySessionState({ id: "old", workingDir: "/w" });
        db.prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("old", "/w", "pending", JSON.stringify(old), 1, 1);
      } finally {
        db.close();
      }

      const store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(100) });
      try {
        expect(store.load("old")?.status).toBe("pending");
        expect(store.beginTurn("old")).toBe(true);
        expect(store.load("old")?.status).toBe("running");
      } finally {
        store.close();
      }

      // Opening it again finds the column already there.
      const again = new SessionStore({ dbFile: file, turnOwnerProbe: probe(100) });
      try {
        expect(again.recoverInterruptedTurns()).toEqual(["old"]);
        expect(again.load("old")?.status).toBe("cancelled");
      } finally {
        again.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
