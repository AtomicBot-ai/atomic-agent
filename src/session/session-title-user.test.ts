import { describe, expect, it } from "vitest";

import { assistantReplyTurn, userTurn } from "./conversation-turn.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, recordTurn } from "./session-state.js";
import {
  SESSION_TITLE_USER_SET_AT_KEY,
  readSessionTitle,
  shouldNameSession,
} from "./session-title.js";
import {
  SESSION_USER_TITLE_MAX_CHARS,
  readUserTitleSetAt,
  validateUserSessionTitle,
} from "./session-title-user.js";

describe("validateUserSessionTitle", () => {
  it("trims and accepts a one-line title", () => {
    expect(validateUserSessionTitle("  Fix the login bug  ")).toEqual({
      ok: true,
      title: "Fix the login bug",
    });
  });

  it("refuses a non-string, an empty and a blank title", () => {
    expect(validateUserSessionTitle(undefined).ok).toBe(false);
    expect(validateUserSessionTitle(42).ok).toBe(false);
    expect(validateUserSessionTitle("").ok).toBe(false);
    expect(validateUserSessionTitle("   ").ok).toBe(false);
  });

  it("refuses a title with a line break in it", () => {
    expect(validateUserSessionTitle("one\ntwo").ok).toBe(false);
    expect(validateUserSessionTitle("one\r\ntwo").ok).toBe(false);
  });

  it("accepts exactly the bound and refuses one character more", () => {
    const max = "я".repeat(SESSION_USER_TITLE_MAX_CHARS);
    expect(validateUserSessionTitle(max)).toEqual({ ok: true, title: max });
    expect(validateUserSessionTitle(`${max}x`).ok).toBe(false);
  });
});

describe("SessionStore.renameSession", () => {
  const fresh = () => {
    const store = new SessionStore({ dbFile: ":memory:" });
    const base = { ...createEmptySessionState({ id: "s-1", workingDir: "/w" }), updatedAt: 1_000 };
    store.save(base);
    return { store, base };
  };

  it("stores the title stamped as the operator's, without moving updatedAt", () => {
    const { store } = fresh();
    const renamed = store.renameSession("s-1", "My chat", 5_000);
    expect(renamed?.metadata?.title).toBe("My chat");
    const loaded = store.load("s-1");
    expect(readSessionTitle(loaded?.metadata)).toBe("My chat");
    expect(readUserTitleSetAt(loaded?.metadata)).toBe(5_000);
    expect(loaded?.updatedAt).toBe(1_000);
  });

  it("returns null for a session that is not stored", () => {
    const { store } = fresh();
    expect(store.renameSession("missing", "Anything")).toBeNull();
    expect(store.load("missing")).toBeNull();
  });

  it("replaces a generated title", () => {
    const { store, base } = fresh();
    store.save({ ...base, metadata: { ...base.metadata, title: "Generated" } });
    store.renameSession("s-1", "Mine", 5_000);
    expect(store.load("s-1")?.metadata?.title).toBe("Mine");
  });

  it("keeps the rename over a stale copy that carries the generated title", () => {
    // A turn loaded its state while the chat still had the namer's
    // title, the operator renamed it mid-turn, then the turn ended.
    const { store, base } = fresh();
    const stale = { ...base, metadata: { ...base.metadata, title: "Generated" } };
    store.save(stale);
    store.renameSession("s-1", "Mine", 5_000);
    store.finishTurn({ ...stale, stepCount: 4 });
    store.save({ ...stale, stepCount: 5 });
    const loaded = store.load("s-1");
    expect(loaded?.metadata?.title).toBe("Mine");
    expect(loaded?.metadata?.[SESSION_TITLE_USER_SET_AT_KEY]).toBe(5_000);
    // The stale writer still lands its own changes.
    expect(loaded?.stepCount).toBe(5);
  });

  it("keeps the newer of two renames over a copy of the older one", () => {
    const { store } = fresh();
    const first = store.renameSession("s-1", "First", 5_000)!;
    store.renameSession("s-1", "Second", 6_000);
    store.save(first);
    expect(store.load("s-1")?.metadata?.title).toBe("Second");
  });

  it("keeps a session renamed before its first answer out of the namer's reach", () => {
    const { store, base } = fresh();
    const asked = recordTurn(base, userTurn("write a long numbered list", 2));
    store.save(asked);
    store.renameSession("s-1", "Lists", 5_000);
    // The turn answers after the rename, on the copy it loaded before.
    store.finishTurn(recordTurn(asked, assistantReplyTurn("1. one", 3)));
    const loaded = store.load("s-1")!;
    expect(loaded.metadata?.title).toBe("Lists");
    expect(shouldNameSession(loaded)).toBe(false);
  });

  it("shows a typed title exactly, even one that looks like reasoning", () => {
    const { store } = fresh();
    store.renameSession("s-1", "<think> notes", 5_000);
    expect(readSessionTitle(store.load("s-1")?.metadata)).toBe("<think> notes");
  });
});
