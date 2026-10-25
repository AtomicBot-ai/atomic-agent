import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INTERRUPTED_TURN_ENDING, SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";

describe("SessionStore.insertMissing", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-insert-missing-"));
    store = new SessionStore({ dbFile: join(dir, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts absent ids and leaves a stored row exactly as it is", () => {
    store.save(createEmptySessionState({ id: "s-kept", workingDir: "/mine" }));

    const inserted = store.insertMissing([
      createEmptySessionState({ id: "s-kept", workingDir: "/theirs" }),
      { ...createEmptySessionState({ id: "s-new", workingDir: "/theirs" }), status: "completed" },
    ]);

    expect(inserted).toEqual(["s-new"]);
    expect(store.load("s-kept")?.workingDir).toBe("/mine");
    expect(store.load("s-new")?.status).toBe("completed");
  });

  it("ends a live status as an interrupted turn and leaves no mark the boot sweep would see", () => {
    store.insertMissing([
      { ...createEmptySessionState({ id: "s-run", workingDir: "/w" }), status: "running" },
      { ...createEmptySessionState({ id: "s-ask", workingDir: "/w" }), status: "awaiting_approval" },
    ]);

    for (const id of ["s-run", "s-ask"]) {
      const state = store.load(id);
      expect(state?.status).toBe(INTERRUPTED_TURN_ENDING.status);
      expect(state?.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
    }
    expect(store.recoverInterruptedTurns({ isOwnerGone: () => true })).toEqual([]);
  });

  it("is a no-op on a second call with the same rows", () => {
    const rows = [createEmptySessionState({ id: "s-1", workingDir: "/w" })];
    expect(store.insertMissing(rows)).toEqual(["s-1"]);
    expect(store.insertMissing(rows)).toEqual([]);
  });
});
