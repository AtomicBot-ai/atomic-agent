import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_MAX_TAGS,
  MEMORY_TAG_MAX_LENGTH,
  MemoryStore,
  MemoryValidationError,
} from "./memory-store.js";

describe("MemoryStore", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores and reads back an entry", () => {
    const entry = store.store(
      { content: "the user prefers concise answers", tags: ["style"] },
      1_000,
    );
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.createdAt).toBe(1_000);
    expect(entry.updatedAt).toBe(1_000);
    expect(entry.source).toBe("agent");
    expect(entry.tags).toEqual(["style"]);
    const fetched = store.get(entry.id);
    expect(fetched?.content).toBe("the user prefers concise answers");
  });

  it("deduplicates tags on input", () => {
    const entry = store.store(
      { content: "dedup tags", tags: ["a", "a", "b"] },
      1_000,
    );
    expect(entry.tags).toEqual(["a", "b"]);
  });

  it("recall ranks exact-phrase matches above unrelated rows", () => {
    store.store({ content: "the cat sat on the mat" }, 1);
    store.store(
      { content: "unrelated trivia about dogs and fish" },
      2,
    );
    store.store({ content: "cats love warm spots" }, 3);
    const hits = store.recall("cat", { k: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.content).toMatch(/cat/);
  });

  it("recall returns empty on empty query", () => {
    store.store({ content: "hello world" }, 1);
    expect(store.recall("   ")).toEqual([]);
    expect(store.recall("")).toEqual([]);
  });

  it("recall tokenises unicode letters", () => {
    store.store({ content: "пользователь предпочитает ёжиков" }, 1);
    const hits = store.recall("ёжик");
    expect(hits.length).toBe(1);
  });

  it("scope=project filters by working_dir", () => {
    store.store(
      { content: "project-local detail", workingDir: "/repos/a" },
      1,
    );
    store.store(
      { content: "other project detail", workingDir: "/repos/b" },
      2,
    );
    const a = store.recall("detail", {
      scope: "project",
      workingDir: "/repos/a",
    });
    expect(a.map((e) => e.workingDir)).toEqual(["/repos/a"]);
    const b = store.recall("detail", {
      scope: "project",
      workingDir: "/repos/b",
    });
    expect(b.map((e) => e.workingDir)).toEqual(["/repos/b"]);
  });

  it("scope=project returns empty when workingDir is missing", () => {
    store.store({ content: "foo", workingDir: "/anywhere" }, 1);
    const hits = store.recall("foo", { scope: "project", workingDir: null });
    expect(hits).toEqual([]);
  });

  it("tag filter applies AND semantics across required tags", () => {
    store.store({ content: "one", tags: ["a"] }, 1);
    store.store({ content: "two", tags: ["a", "b"] }, 2);
    store.store({ content: "three", tags: ["b"] }, 3);
    const withA = store.recall("one OR two OR three", { tags: ["a"] });
    expect(withA.map((e) => e.content).sort()).toEqual(["one", "two"]);
    const withAB = store.recall("one OR two OR three", {
      tags: ["a", "b"],
    });
    expect(withAB.map((e) => e.content)).toEqual(["two"]);
  });

  it("remove deletes the row and mirrors into FTS5", () => {
    const entry = store.store({ content: "ephemeral fact" }, 1);
    expect(store.remove(entry.id)).toBe(true);
    expect(store.get(entry.id)).toBeNull();
    expect(store.recall("ephemeral")).toEqual([]);
    expect(store.remove(entry.id)).toBe(false);
  });

  it("eviction trims oldest rows when over maxEntries", () => {
    const small = new MemoryStore({
      dbFile: join(tmp, "small.sqlite"),
      maxEntries: 3,
    });
    try {
      const first = small.store({ content: "a" }, 1);
      small.store({ content: "b" }, 2);
      small.store({ content: "c" }, 3);
      expect(small.count()).toBe(3);
      small.store({ content: "d" }, 4);
      expect(small.count()).toBe(3);
      expect(small.get(first.id)).toBeNull();
    } finally {
      small.close();
    }
  });

  it("list orders by updated_at DESC", () => {
    store.store({ content: "first" }, 1_000);
    store.store({ content: "second" }, 2_000);
    store.store({ content: "third" }, 3_000);
    const all = store.list();
    expect(all.map((e) => e.content)).toEqual(["third", "second", "first"]);
  });

  it("rejects invalid content", () => {
    expect(() => store.store({ content: "" })).toThrow(MemoryValidationError);
    expect(() => store.store({ content: "   " })).toThrow(
      MemoryValidationError,
    );
    expect(() =>
      store.store({ content: "x".repeat(MEMORY_CONTENT_MAX_LENGTH + 1) }),
    ).toThrow(MemoryValidationError);
  });

  it("rejects invalid tags", () => {
    expect(() =>
      store.store({ content: "ok", tags: ["good", ""] }),
    ).toThrow(MemoryValidationError);
    expect(() =>
      store.store({
        content: "ok",
        tags: ["a".repeat(MEMORY_TAG_MAX_LENGTH + 1)],
      }),
    ).toThrow(MemoryValidationError);
    const tooMany = Array.from(
      { length: MEMORY_MAX_TAGS + 1 },
      (_, i) => `t${i}`,
    );
    expect(() => store.store({ content: "ok", tags: tooMany })).toThrow(
      MemoryValidationError,
    );
  });

  it("rejects non-positive ids in get/remove", () => {
    expect(() => store.get(0)).toThrow(MemoryValidationError);
    expect(() => store.remove(-1)).toThrow(MemoryValidationError);
  });

  it("survives reopen — durable across store instances", () => {
    store.store({ content: "durable note", tags: ["persist"] }, 1);
    store.close();
    const reopened = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
    try {
      const hits = reopened.recall("durable");
      expect(hits.length).toBe(1);
      expect(hits[0]?.tags).toEqual(["persist"]);
    } finally {
      reopened.close();
    }
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });
});
