import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";
import { sessionTrashedForSearch } from "./session-search.js";

// ATO-2332: a chat in the desktop's Trash is left out of search and its hit read.
describe("session search and the Trash flag", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-sess-trash-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function chat(id: string, text: string): void {
    store.save({
      ...createEmptySessionState({ id, workingDir: "/w" }),
      turns: [
        { kind: "user", text, at: 1 },
        { kind: "assistant_reply", text: "noted", at: 2 },
      ],
    });
  }
  const found = (query: string) =>
    [...new Set(store.searchTranscripts({ query }).hits.map((h) => h.sessionId))].sort();

  it("hides a chat trashed after it was indexed, and shows it again once restored", () => {
    chat("s1", "the staging password rotation plan");
    chat("s2", "staging deploy notes");
    expect(found("staging")).toEqual(["s1", "s2"]);
    expect(store.listSearchableChatLines("s1").length).toBeGreaterThan(0);

    expect(store.setSessionTrashed("s1", true)?.metadata?.trashed).toBe(true);
    expect(found("staging")).toEqual(["s2"]);
    expect(store.listSearchableChatLines("s1")).toEqual([]);

    store.setSessionTrashed("s1", false);
    expect(found("staging")).toEqual(["s1", "s2"]);
    expect(store.listSearchableChatLines("s1").length).toBeGreaterThan(0);
  });

  it("a chat trashed before the first search is hidden, and searchable once restored", () => {
    chat("s1", "quarterly budget draft");
    store.setSessionTrashed("s1", true);
    expect(found("budget")).toEqual([]);
    store.setSessionTrashed("s1", false);
    expect(found("budget")).toEqual(["s1"]);
  });

  it("a copy read before the move to Trash cannot take the flag back off (a late turn, the namer, the TUI)", () => {
    chat("s1", "the staging password rotation plan");
    const old = store.load("s1");
    if (old === null) throw new Error("not stored");
    store.setSessionTrashed("s1", true);
    store.save({ ...old, turns: [...old.turns, { kind: "assistant_reply", text: "staging again", at: 3 }] });
    expect(store.load("s1")?.metadata?.trashed).toBe(true);
    expect(found("staging")).toEqual([]);
    expect(store.listSearchableChatLines("s1")).toEqual([]);
  });

  it("a copy read while it was in Trash cannot put it back in Trash after Restore", () => {
    chat("s1", "quarterly budget draft");
    store.setSessionTrashed("s1", true, 1_000);
    const inTrash = store.load("s1");
    if (inTrash === null) throw new Error("not stored");
    store.setSessionTrashed("s1", false, 2_000);
    store.save(inTrash);
    const stored = store.load("s1");
    expect(stored?.metadata?.trashed).toBeUndefined();
    expect(stored?.metadata?.trashedSetAt).toBe(2_000);
    expect(found("budget")).toEqual(["s1"]);
  });

  it("reads only a literal true as trashed", () => {
    expect(sessionTrashedForSearch({ metadata: JSON.stringify({ trashed: true }) })).toBe(true);
    expect(sessionTrashedForSearch({ metadata: JSON.stringify({ trashed: "yes" }) })).toBe(false);
    expect(sessionTrashedForSearch({ metadata: JSON.stringify({}) })).toBe(false);
    expect(sessionTrashedForSearch({ metadata: "{not json" })).toBe(false);
    expect(sessionTrashedForSearch({ metadata: null })).toBe(false);
  });

  it("returns null for an unknown session", () => {
    expect(store.setSessionTrashed("missing", true)).toBeNull();
  });
});
