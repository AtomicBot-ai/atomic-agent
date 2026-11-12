import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, type SessionState } from "./session-state.js";
import type { ConversationTurn } from "./conversation-turn.js";
import { SESSION_SEARCH_PER_SESSION, searchTerms } from "./session-search.js";

// ATO-1149: full-text search over the chat lines of stored sessions.
describe("SessionStore.searchTranscripts", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-sess-search-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function session(
    id: string,
    turns: ConversationTurn[],
    extra: Partial<SessionState> = {},
  ): SessionState {
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: "/w" }),
      turns,
      ...extra,
    };
    store.save(state);
    return state;
  }

  it("finds user messages and replies, with the session and line", () => {
    session(
      "s1",
      [
        { kind: "user", text: "how do we deploy the staging server?", at: 1 },
        { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "deploy" }, at: 2 },
        { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "deploy secret output", at: 3 },
        { kind: "assistant_reply", text: "Run make deploy-staging from the repo root.", at: 4 },
      ],
      { metadata: { title: "Staging deploy" } },
    );
    const { hits, pending } = store.searchTranscripts({ query: "staging" });
    expect(pending).toBe(0);
    expect(hits.map((h) => [h.sessionId, h.line, h.kind])).toEqual(
      expect.arrayContaining([
        ["s1", 0, "user"],
        ["s1", 1, "assistant_reply"],
      ]),
    );
    expect(hits[0]?.title).toBe("Staging deploy");
    expect(hits[0]?.workingDir).toBe("/w");
    expect(hits.some((h) => h.snippet.includes("«"))).toBe(true);
    // Tool output is not indexed.
    expect(store.searchTranscripts({ query: "secret" }).hits).toEqual([]);
  });

  it("matches Cyrillic words and word prefixes", () => {
    session("ru", [{ kind: "user", text: "Решили перенести релиз на четверг", at: 1 }]);
    expect(store.searchTranscripts({ query: "релиз" }).hits).toHaveLength(1);
    expect(store.searchTranscripts({ query: "четв" }).hits).toHaveLength(1);
  });

  it("requires every word first, then falls back to any of them", () => {
    session("a", [{ kind: "user", text: "postgres migration plan", at: 1 }]);
    session("b", [{ kind: "user", text: "postgres backup", at: 1 }]);
    const both = store.searchTranscripts({ query: "postgres migration" });
    expect(both.hits.map((h) => h.sessionId)).toEqual(["a"]);
    const either = store.searchTranscripts({ query: "migration backup" });
    expect(new Set(either.hits.map((h) => h.sessionId))).toEqual(new Set(["a", "b"]));
  });

  it("treats FTS5 syntax in the query as plain words", () => {
    session("s", [{ kind: "user", text: "the NEAR column (draft) - final", at: 1 }]);
    for (const query of ['"', "(draft", "-final", "text:draft", "*", "NEAR(", "a OR"]) {
      expect(() => store.searchTranscripts({ query }), query).not.toThrow();
    }
    expect(store.searchTranscripts({ query: '"(draft"' }).hits).toHaveLength(1);
    expect(store.searchTranscripts({ query: "!!!" }).hits).toEqual([]);
    expect(searchTerms("Hello, мир!")).toEqual(['"hello"*', '"мир"*']);
  });

  it("leaves out the excluded session and filters by working directory", () => {
    session("here", [{ kind: "user", text: "kubernetes", at: 1 }]);
    store.save({
      ...createEmptySessionState({ id: "there", workingDir: "/other" }),
      turns: [{ kind: "user", text: "kubernetes", at: 1 }],
    });
    expect(
      store.searchTranscripts({ query: "kubernetes", excludeSessionId: "here" }).hits.map((h) => h.sessionId),
    ).toEqual(["there"]);
    expect(
      store.searchTranscripts({ query: "kubernetes", workingDir: "/w" }).hits.map((h) => h.sessionId),
    ).toEqual(["here"]);
  });

  it("caps hits per session and in total", () => {
    const many: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
      kind: "user" as const,
      text: `invoice number ${i}`,
      at: i,
    }));
    session("long", many);
    session("short", [{ kind: "user", text: "invoice", at: 1 }]);
    const { hits } = store.searchTranscripts({ query: "invoice" });
    expect(hits.filter((h) => h.sessionId === "long")).toHaveLength(SESSION_SEARCH_PER_SESSION);
    expect(hits.some((h) => h.sessionId === "short")).toBe(true);
    expect(store.searchTranscripts({ query: "invoice", limit: 2 }).hits).toHaveLength(2);
  });

  it("reindexes a session whose row changed since the last search", () => {
    const state = session("s", [{ kind: "user", text: "alpha", at: 1 }]);
    expect(store.searchTranscripts({ query: "alpha" }).hits).toHaveLength(1);
    store.save({
      ...state,
      turns: [{ kind: "user", text: "beta", at: 2 }],
      updatedAt: state.updatedAt + 1000,
    });
    expect(store.searchTranscripts({ query: "alpha" }).hits).toEqual([]);
    expect(store.searchTranscripts({ query: "beta" }).hits).toHaveLength(1);
  });

  it("drops a deleted session's lines, by delete and by a raw prune", () => {
    session("gone", [{ kind: "user", text: "zebra", at: 1 }]);
    session("pruned", [{ kind: "user", text: "giraffe", at: 1 }]);
    expect(store.searchTranscripts({ query: "zebra" }).hits).toHaveLength(1);
    expect(store.searchTranscripts({ query: "giraffe" }).hits).toHaveLength(1);
    store.delete("gone");
    const raw = new DatabaseCtor(file);
    try {
      expect(
        raw.prepare(`SELECT COUNT(*) AS n FROM session_search_lines WHERE session_id = 'gone'`).get(),
      ).toEqual({ n: 0 });
      // The retention prune deletes rows on the raw handle.
      raw.prepare(`DELETE FROM sessions WHERE id = 'pruned'`).run();
    } finally {
      raw.close();
    }
    expect(store.searchTranscripts({ query: "giraffe" }).hits).toEqual([]);
    const check = new DatabaseCtor(file);
    try {
      expect(
        check.prepare(`SELECT COUNT(*) AS n FROM session_search_lines WHERE session_id = 'pruned'`).get(),
      ).toEqual({ n: 0 });
    } finally {
      check.close();
    }
  });

  it("indexes sessions written before the index existed, and skips unreadable rows", () => {
    const raw = new DatabaseCtor(file);
    try {
      raw
        .prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES ('bad', '/w', 'pending', '{not json', 9, 9000)`,
        )
        .run();
    } finally {
      raw.close();
    }
    session("old", [{ kind: "user", text: "legacy words", at: 1 }]);
    const result = store.searchTranscripts({ query: "legacy" });
    expect(result.hits.map((h) => h.sessionId)).toEqual(["old"]);
    expect(result.pending).toBe(0);
  });

  it("deleting a session before any search does not need the index", () => {
    session("s", [{ kind: "user", text: "x", at: 1 }]);
    expect(() => store.delete("s")).not.toThrow();
  });
});
