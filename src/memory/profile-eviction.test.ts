import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

import type { ProfileEviction } from "./profile-eviction.js";
import { ProfileStore } from "./profile-store.js";

/**
 * Issue #407. `memory.profile.maxEntries` caps active unpinned facts;
 * pinned facts are never counted or evicted; eviction happens inside
 * the write transaction and deletes like `remove()` does.
 */
describe("ProfileStore maxEntries", () => {
  let dir: string;
  let dbFile: string;
  let evictions: ProfileEviction[];
  let stores: ProfileStore[];

  const open = (maxEntries?: number): ProfileStore => {
    const store = new ProfileStore({
      dbFile,
      ...(maxEntries !== undefined ? { maxEntries } : {}),
      onEvicted: (eviction) => evictions.push(eviction),
    });
    stores.push(store);
    return store;
  };
  /** Side door for state the store's API cannot set (votes, triggers). */
  const sql = (statement: string, ...params: unknown[]): void => {
    const db = new DatabaseCtor(dbFile);
    try {
      db.prepare(statement).run(...params);
    } finally {
      db.close();
    }
  };
  const contextual = { pinned: false, keywords: ["topic"] };
  const keys = (store: ProfileStore): string[] =>
    store.list().map((fact) => fact.key);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-profile-cap-"));
    dbFile = join(dir, "memory.sqlite");
    evictions = [];
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no cap when maxEntries is omitted", () => {
    const store = open();
    for (let i = 0; i < 20; i += 1) {
      store.set(`k${i}`, "v", contextual, 1_000 + i);
    }
    expect(store.list()).toHaveLength(20);
    expect(evictions).toEqual([]);
  });

  it("evicts the stalest unpinned fact when a write passes the cap", () => {
    const store = open(3);
    store.set("a", "1", contextual, 1_000);
    store.set("b", "2", contextual, 2_000);
    store.set("c", "3", contextual, 3_000);
    expect(evictions).toEqual([]);

    store.set("d", "4", contextual, 4_000);

    expect(keys(store)).toEqual(["b", "c", "d"]);
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toMatchObject({
      maxEntries: 3,
      activeUnpinned: 3,
      evicted: [{ key: "a" }],
    });
  });

  it("never evicts a pinned fact, even when pinned facts alone exceed the cap", () => {
    const store = open(2);
    // Pinned rows are the oldest: an eviction that counted them would
    // take them first.
    for (let i = 0; i < 5; i += 1) {
      store.set(`pinned_${i}`, "v", { pinned: true }, 1_000 + i);
    }
    store.set("ctx_a", "1", contextual, 10_000);
    store.set("ctx_b", "2", contextual, 11_000);
    expect(evictions).toEqual([]);

    store.set("ctx_c", "3", contextual, 12_000);
    // A pinned write is neither counted nor a trigger.
    store.set("pinned_5", "v", { pinned: true }, 13_000);

    const active = keys(store);
    for (let i = 0; i <= 5; i += 1) expect(active).toContain(`pinned_${i}`);
    expect(active).not.toContain("ctx_a");
    expect(active).toEqual(expect.arrayContaining(["ctx_b", "ctx_c"]));
    expect(evictions).toHaveLength(1);
    expect(evictions[0]!.evicted.map((f) => f.key)).toEqual(["ctx_a"]);
  });

  it("evicts a downvoted fact before an older neutral one", () => {
    const store = open(2);
    store.set("old_neutral", "1", contextual, 1_000);
    const newer = store.set("newer_downvoted", "2", contextual, 2_000);
    sql("UPDATE profile_facts SET vote_score = -1 WHERE id = ?", newer.id);

    store.set("c", "3", contextual, 3_000);

    expect(evictions[0]!.evicted.map((f) => f.key)).toEqual([
      "newer_downvoted",
    ]);
  });

  it("breaks a tie on score and age by id", () => {
    const store = open(2);
    const first = store.set("second_key_first_id", "1", contextual, 1_000);
    store.set("a_first_key_second_id", "2", contextual, 1_000);

    store.set("c", "3", contextual, 3_000);

    expect(evictions[0]!.evicted).toEqual([
      { id: first.id, key: "second_key_first_id" },
    ]);
  });

  it("never evicts the fact being written", () => {
    const store = open(1);
    const old = store.set("old", "1", contextual, 5_000);
    // Upvote the old row so the incoming one would rank first if it
    // were a candidate.
    sql("UPDATE profile_facts SET vote_score = 3 WHERE id = ?", old.id);

    store.set("new", "2", contextual, 6_000);

    expect(store.get("new")).not.toBeNull();
    expect(store.get("old")).toBeNull();
  });

  it("evicts inside the write transaction: a failed eviction rolls the insert back", () => {
    const store = open(1);
    store.set("a", "1", contextual, 1_000);
    sql(
      `CREATE TRIGGER no_delete BEFORE DELETE ON profile_facts
       BEGIN SELECT RAISE(ABORT, 'delete refused'); END`,
    );

    expect(() => store.set("b", "2", contextual, 2_000)).toThrow(
      /delete refused/,
    );

    expect(keys(store)).toEqual(["a"]);
    expect(store.history("b")).toEqual([]);
    expect(evictions).toEqual([]);
  });

  it("does not count a supersession twice, and keeps history coherent after an eviction", () => {
    const store = open(2);
    store.set("editor", "vim", contextual, 1_000);
    store.set("editor", "emacs", contextual, 2_000);
    store.set("shell", "zsh", contextual, 3_000);
    expect(evictions).toEqual([]);

    store.set("term", "kitty", contextual, 4_000);

    // The active `editor` row went, as with `remove()`; its superseded
    // predecessor stays readable.
    expect(store.get("editor")).toBeNull();
    const chain = store.history("editor");
    expect(chain.map((f) => f.value)).toEqual(["vim"]);
    expect(chain[0]!.supersededBy).not.toBeNull();

    // A later write starts a fresh active row at the end of the chain.
    store.set("editor", "helix", contextual, 5_000);
    const after = store.history("editor");
    expect(after.map((f) => f.value)).toEqual(["vim", "helix"]);
    expect(after[1]!.supersedes).toBeNull();
    expect(after[1]!.supersededBy).toBeNull();
    expect(keys(store)).toEqual(["editor", "term"]);
  });

  it("does not fail the write when the eviction listener throws", () => {
    const store = new ProfileStore({
      dbFile,
      maxEntries: 1,
      onEvicted: () => {
        throw new Error("listener broke");
      },
    });
    stores.push(store);
    store.set("a", "1", contextual, 1_000);

    expect(() => store.set("b", "2", contextual, 2_000)).not.toThrow();
    expect(keys(store)).toEqual(["b"]);
  });

  it("rejects a cap that is not a positive integer", () => {
    expect(() => open(0)).toThrow(/maxEntries/);
    expect(() => open(1.5)).toThrow(/maxEntries/);
  });
});
