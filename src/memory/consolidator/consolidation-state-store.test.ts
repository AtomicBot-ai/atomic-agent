import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";

import {
  abstainBackoffMs,
  ConsolidationStateStore,
  MAX_COUNTED_ABSTAINS,
} from "./consolidation-state-store.js";

const policy = { baseMs: 1_000, maxMs: 10_000 };

describe("abstainBackoffMs", () => {
  it("waits baseMs after the first abstain and doubles up to maxMs", () => {
    expect(abstainBackoffMs(1, policy)).toBe(1_000);
    expect(abstainBackoffMs(2, policy)).toBe(2_000);
    expect(abstainBackoffMs(3, policy)).toBe(4_000);
    expect(abstainBackoffMs(4, policy)).toBe(8_000);
    expect(abstainBackoffMs(5, policy)).toBe(10_000);
    expect(abstainBackoffMs(MAX_COUNTED_ABSTAINS + 50, policy)).toBe(10_000);
  });

  it("never returns less than baseMs when maxMs is set lower", () => {
    expect(abstainBackoffMs(3, { baseMs: 5_000, maxMs: 1 })).toBe(5_000);
  });
});

describe("ConsolidationStateStore", () => {
  let dir: string;
  let memoryStore: MemoryStore;
  let state: ConsolidationStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-consolidation-state-"));
    memoryStore = new MemoryStore({
      dbFile: join(dir, "memory.sqlite"),
      maxEntries: 100,
    });
    state = new ConsolidationStateStore({
      db: memoryStore.getDatabaseHandleForEmbeddings(),
    });
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the backoff columns to memories on open", () => {
    const columns = memoryStore
      .getDatabaseHandleForEmbeddings()
      .prepare(`PRAGMA table_info(memories)`)
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("consolidation_abstains");
    expect(names).toContain("consolidation_retry_at");
  });

  it("counts repeat abstains per note and doubles the wait", () => {
    const a = memoryStore.store({ content: "note A", source: "agent" });
    expect(state.getBackoff(a.id)).toBeNull();

    expect(state.deferAbstained([a.id], 100_000, policy)).toBe(1);
    expect(state.getBackoff(a.id)).toEqual({ abstains: 1, retryAt: 101_000 });

    expect(state.deferAbstained([a.id], 200_000, policy)).toBe(1);
    expect(state.getBackoff(a.id)).toEqual({ abstains: 2, retryAt: 202_000 });
  });

  it("skips archived and missing notes", () => {
    const a = memoryStore.store({ content: "note A", source: "agent" });
    const b = memoryStore.store({ content: "note B", source: "agent" });
    memoryStore.archiveInto([b.id], 42);
    expect(state.deferAbstained([a.id, b.id, 9_999], 1_000, policy)).toBe(1);
    expect(state.getBackoff(b.id)).toBeNull();
  });

  it("keeps a deferred note out of a due-filtered list until its retry time", () => {
    const a = memoryStore.store({ content: "note A", source: "agent" }, 10);
    memoryStore.store({ content: "note B", source: "agent" }, 10);
    state.deferAbstained([a.id], 1_000, policy);
    const due = (at: number) =>
      memoryStore
        .list({ consolidationDueAt: at })
        .map((e) => e.id)
        .includes(a.id);
    expect(due(1_500)).toBe(false);
    expect(due(2_000)).toBe(true);
    // Callers that do not ask for the filter still see the note.
    expect(memoryStore.list().map((e) => e.id)).toContain(a.id);
  });

  it("clears the backoff when a note's content or tags change", () => {
    const [a, b, c] = ["A", "B", "C"].map((n) =>
      memoryStore.store({ content: `note ${n}`, source: "agent", tags: ["x"] }),
    );
    state.deferAbstained([a!.id, b!.id, c!.id], 1_000, policy);

    memoryStore.updateContent(a!.id, "note A, edited");
    memoryStore.setTags(b!.id, ["x", "y"]);
    memoryStore.evolveTags(c!.id, ["z"], { leaseMs: 0 });

    expect(state.getBackoff(a!.id)).toBeNull();
    expect(state.getBackoff(b!.id)).toBeNull();
    expect(state.getBackoff(c!.id)).toBeNull();
  });

  it("stores, reads back and clears the page cursor", () => {
    expect(state.readCursor()).toBeNull();
    state.writeCursor({ updatedAt: 1_234, id: 7 });
    expect(state.readCursor()).toEqual({ updatedAt: 1_234, id: 7 });
    state.writeCursor({ updatedAt: 5_678, id: 9 });
    expect(state.readCursor()).toEqual({ updatedAt: 5_678, id: 9 });
    state.writeCursor(null);
    expect(state.readCursor()).toBeNull();
  });

  it("keeps the cursor across a reopen of the file", () => {
    state.writeCursor({ updatedAt: 1_234, id: 7 });
    memoryStore.close();
    memoryStore = new MemoryStore({
      dbFile: join(dir, "memory.sqlite"),
      maxEntries: 100,
    });
    state = new ConsolidationStateStore({
      db: memoryStore.getDatabaseHandleForEmbeddings(),
    });
    expect(state.readCursor()).toEqual({ updatedAt: 1_234, id: 7 });
  });
});
