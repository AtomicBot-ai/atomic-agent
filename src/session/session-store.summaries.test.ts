import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, recordTurn } from "./session-state.js";
import { userTurn, assistantReplyTurn } from "./conversation-turn.js";
import { summarizeSessionState } from "./session-summary.js";

/**
 * Write a row the store itself would never write, through a second
 * handle on the same file: the store has no API for a broken payload,
 * and that is the point — the rows come from a truncated write or a
 * hand edit, not from `save`.
 */
function insertRaw(
  file: string,
  id: string,
  payload: string,
  updatedAt: number,
) {
  const raw = new DatabaseCtor(file);
  try {
    raw
      .prepare(
        `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
         VALUES (?, '/raw', 'pending', ?, ?, ?)`,
      )
      .run(id, payload, updatedAt, updatedAt);
  } finally {
    raw.close();
  }
}

describe("SessionStore.listSummaries", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-summ-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] on an empty table", () => {
    expect(store.listSummaries()).toEqual([]);
    expect(store.countUnreadable()).toBe(0);
  });

  it("lists every session newest first with the first prompt lifted out", () => {
    const a = recordTurn(
      createEmptySessionState({ id: "a", workingDir: "/w" }),
      userTurn("first thing said"),
    );
    const b = recordTurn(
      recordTurn(
        createEmptySessionState({ id: "b", workingDir: "/w" }),
        userTurn("hello"),
      ),
      assistantReplyTurn("hi"),
    );
    const c = createEmptySessionState({ id: "c", workingDir: "/w" });
    store.save({ ...a, updatedAt: 1000, turnCount: 3, stepCount: 7 });
    store.save({ ...b, updatedAt: 3000 });
    store.save({ ...c, updatedAt: 2000 });
    const rows = store.listSummaries();
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows[2]).toMatchObject({
      id: "a",
      workingDir: "/w",
      status: "pending",
      updatedAt: 1000,
      turnCount: 3,
      stepCount: 7,
      firstPrompt: "first thing said",
      importedFrom: null,
    });
    expect(rows[0]?.firstPrompt).toBe("hello");
  });

  it("gives an unnamed session firstPrompt: null, and an empty prompt ''", () => {
    const unnamed = createEmptySessionState({ id: "u", workingDir: "/w" });
    const empty = recordTurn(
      createEmptySessionState({ id: "e", workingDir: "/w" }),
      userTurn(""),
    );
    store.save({ ...unnamed, updatedAt: 1 });
    store.save({ ...empty, updatedAt: 2 });
    const byId = new Map(store.listSummaries().map((r) => [r.id, r]));
    expect(byId.get("u")?.firstPrompt).toBeNull();
    expect(byId.get("e")?.firstPrompt).toBe("");
  });

  it("reads importedFrom out of the metadata", () => {
    const s = createEmptySessionState({
      id: "imp",
      workingDir: "/w",
      metadata: { importedFrom: "hermes" },
    });
    store.save(s);
    expect(store.listSummaries()[0]?.importedFrom).toBe("hermes");
  });

  it("agrees with summarizeSessionState on a saved state", () => {
    const s = recordTurn(
      createEmptySessionState({
        id: "same",
        workingDir: "/w",
        metadata: { importedFrom: "codex" },
      }),
      userTurn("prompt"),
    );
    const saved = {
      ...s,
      updatedAt: 42,
      createdAt: 41,
      turnCount: 1,
      stepCount: 2,
    };
    store.save(saved);
    expect(store.listSummaries()[0]).toEqual(summarizeSessionState(saved));
  });

  it("skips a corrupt payload row and counts it as unreadable", () => {
    store.save({
      ...createEmptySessionState({ id: "ok", workingDir: "/w" }),
      updatedAt: 1,
    });
    insertRaw(file, "bad", '{"id":"bad","turns":[', 9999);
    expect(store.listSummaries().map((r) => r.id)).toEqual(["ok"]);
    expect(store.countUnreadable()).toBe(1);
  });

  it("leaves out a payload with no turns array, without counting it unreadable", () => {
    store.save({
      ...createEmptySessionState({ id: "ok", workingDir: "/w" }),
      updatedAt: 1,
    });
    insertRaw(file, "empty-object", "{}", 5000);
    insertRaw(file, "string-turns", '{"id":"string-turns","turns":"x"}', 6000);
    expect(store.listSummaries().map((r) => r.id)).toEqual(["ok"]);
    expect(store.countUnreadable()).toBe(0);
  });

  it("coerces missing counts to 0 and non-object turns to no prompt", () => {
    insertRaw(
      file,
      "thin",
      '{"id":"thin","turns":[1,"two",{"kind":"user","text":"three"}]}',
      1,
    );
    const [row] = store.listSummaries();
    expect(row).toMatchObject({
      turnCount: 0,
      stepCount: 0,
      firstPrompt: "three",
    });
  });
});
