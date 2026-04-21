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
    expect(loaded!.worldSnapshot).toBeNull();
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

  it("delete removes a session", () => {
    const state = createEmptySessionState({ id: "x", workingDir: "/w" });
    store.save(state);
    expect(store.load("x")).not.toBeNull();
    store.delete("x");
    expect(store.load("x")).toBeNull();
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
