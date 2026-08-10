import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";

describe("SessionStore", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-sess-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a session state", () => {
    const initial = createEmptySessionState({
      id: "s1",
      workingDir: "/work",
    });
    store.save(initial);
    const loaded = store.load("s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("s1");
    expect(loaded!.workingDir).toBe("/work");
    expect(loaded!.turns).toEqual([]);
    expect(loaded!.turnCount).toBe(0);
    expect(loaded!.loadedSkills).toEqual([]);
    expect(loaded!.loadedTools).toEqual([]);
    expect(loaded!.worldSnapshot).toBeNull();
  });

  it("round-trips loadedTools on the session payload", () => {
    const initial = createEmptySessionState({
      id: "s-tools",
      workingDir: "/w",
    });
    const withTools = {
      ...initial,
      loadedTools: [
        {
          name: "os.git.show",
          summary: "Show commit",
          argsSchema: "{ revision?: string }",
          loadedAt: 99,
          source: "explicit" as const,
        },
      ],
    };
    store.save(withTools);
    const loaded = store.load("s-tools");
    expect(loaded?.loadedTools).toHaveLength(1);
    expect(loaded?.loadedTools[0]?.name).toBe("os.git.show");
  });

  it("updates an existing session in place", () => {
    const state = createEmptySessionState({
      id: "s2",
      workingDir: "/work",
    });
    store.save(state);
    store.save({
      ...state,
      status: "running",
      stepCount: 3,
      updatedAt: Date.now() + 100,
    });
    const loaded = store.load("s2")!;
    expect(loaded.status).toBe("running");
    expect(loaded.stepCount).toBe(3);
  });

  it("lists sessions by working dir ordered by recency", () => {
    const a = createEmptySessionState({ id: "a", workingDir: "/w" });
    const b = createEmptySessionState({ id: "b", workingDir: "/w" });
    const c = createEmptySessionState({ id: "c", workingDir: "/other" });
    store.save(a);
    store.save({ ...b, updatedAt: b.updatedAt + 1000 });
    store.save(c);
    const list = store.listByWorkingDir("/w", 10);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("lists recent sessions across working dirs ordered by updated_at", () => {
    const a = createEmptySessionState({ id: "a", workingDir: "/w1" });
    const b = createEmptySessionState({ id: "b", workingDir: "/w2" });
    const c = createEmptySessionState({ id: "c", workingDir: "/w3" });
    store.save({ ...a, updatedAt: 1000 });
    store.save({ ...b, updatedAt: 3000 });
    store.save({ ...c, updatedAt: 2000 });
    const recent = store.listRecent(10);
    expect(recent.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("listRecent honours the limit", () => {
    for (let i = 0; i < 5; i += 1) {
      store.save({
        ...createEmptySessionState({ id: `s${i}`, workingDir: "/w" }),
        updatedAt: 1000 + i,
      });
    }
    const limited = store.listRecent(2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.id).toBe("s4");
    expect(limited[1]?.id).toBe("s3");
  });

  it("listRecentWorkingDirs returns column-only rows ordered by updated_at", () => {
    const a = createEmptySessionState({ id: "a", workingDir: "/w1" });
    const b = createEmptySessionState({ id: "b", workingDir: "/w2" });
    const c = createEmptySessionState({ id: "c", workingDir: "/w3" });
    store.save({ ...a, updatedAt: 1000 });
    store.save({ ...b, updatedAt: 3000 });
    store.save({ ...c, updatedAt: 2000 });

    const rows = store.listRecentWorkingDirs(2);
    // Narrow projection: exactly {workingDir, updatedAt}, no payload
    // deserialisation involved.
    expect(rows).toEqual([
      { workingDir: "/w2", updatedAt: 3000 },
      { workingDir: "/w3", updatedAt: 2000 },
    ]);
  });

  it("delete removes a session", () => {
    const state = createEmptySessionState({ id: "x", workingDir: "/w" });
    store.save(state);
    expect(store.load("x")).not.toBeNull();
    store.delete("x");
    expect(store.load("x")).toBeNull();
  });

  it("does not persist ephemeral recalledNotes and memoryIndex fields", () => {
    const state = createEmptySessionState({ id: "eph", workingDir: "/w" });
    store.save({
      ...state,
      recalledNotes: [
        {
          id: 1,
          content: "note",
          tags: ["x"],
          metadata: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      memoryIndex: [
        { id: 1, preview: "note", tags: ["x"], updatedAt: 1 },
      ],
    });
    const loaded = store.load("eph")!;
    expect(loaded.recalledNotes).toBeUndefined();
    expect(loaded.memoryIndex).toBeUndefined();
  });

  it("creates an empty session with no turns by default", () => {
    const state = createEmptySessionState({
      id: "chat",
      workingDir: "/w",
    });
    expect(state.turns).toEqual([]);
    expect(state.turnCount).toBe(0);
    expect(state.status).toBe("pending");
  });
});
