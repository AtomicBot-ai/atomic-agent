import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";

import { selectCandidatePage } from "./candidate-window.js";
import { ConsolidationStateStore } from "./consolidation-state-store.js";

describe("selectCandidatePage (ATO-2506)", () => {
  let dir: string;
  let memoryStore: MemoryStore;
  let stateStore: ConsolidationStateStore;
  const now = 100_000;

  const page = () =>
    selectCandidatePage(
      { memoryStore, stateStore },
      { now, cooldownMs: 0, pageSize: 3 },
    );
  const ids = (window: ReturnType<typeof page>) =>
    window.candidates.map((e) => e.id);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-candidate-window-"));
    memoryStore = new MemoryStore({
      dbFile: join(dir, "memory.sqlite"),
      maxEntries: 100,
    });
    stateStore = new ConsolidationStateStore({
      db: memoryStore.getDatabaseHandleForEmbeddings(),
    });
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("walks to older notes tick by tick, then starts over from the newest", () => {
    // n1 oldest ... n7 newest.
    const notes = [1, 2, 3, 4, 5, 6, 7].map((i) =>
      memoryStore.store({ content: `note ${i}`, source: "agent" }, i * 1_000),
    );
    const [n1, n2, n3, n4, n5, n6, n7] = notes.map((n) => n.id);

    const first = page();
    expect(first.page).toBe("first");
    expect(ids(first)).toEqual([n7, n6, n5]);

    const second = page();
    expect(second.page).toBe("next");
    expect(ids(second)).toEqual([n4, n3, n2]);

    // A short page: the oldest note is reached and the cursor clears.
    const third = page();
    expect(third.page).toBe("next");
    expect(ids(third)).toEqual([n1]);
    expect(stateStore.readCursor()).toBeNull();

    const fourth = page();
    expect(fourth.page).toBe("first");
    expect(ids(fourth)).toEqual([n7, n6, n5]);
  });

  it("breaks updated_at ties by id so no note is skipped between pages", () => {
    const notes = [1, 2, 3, 4, 5].map((i) =>
      memoryStore.store({ content: `same time ${i}`, source: "agent" }, 5_000),
    );
    const seen = [...ids(page()), ...ids(page())];
    expect(seen.sort((a, b) => a - b)).toEqual(notes.map((n) => n.id));
  });

  it("starts over from the newest when the page after the cursor is empty", () => {
    const notes = [1, 2, 3, 4].map((i) =>
      memoryStore.store({ content: `note ${i}`, source: "agent" }, i * 1_000),
    );
    expect(ids(page())).toEqual([notes[3]!.id, notes[2]!.id, notes[1]!.id]);
    // The only older note is consolidated before the next tick.
    memoryStore.archiveInto([notes[0]!.id], 1);

    const next = page();
    expect(next.page).toBe("wrapped");
    expect(ids(next)).toEqual([notes[3]!.id, notes[2]!.id, notes[1]!.id]);
  });

  it("leaves out notes put off by an abstain backoff", () => {
    const a = memoryStore.store({ content: "note A", source: "agent" }, 1_000);
    const b = memoryStore.store({ content: "note B", source: "agent" }, 2_000);
    stateStore.deferAbstained([b.id], now, { baseMs: 60_000, maxMs: 60_000 });
    expect(ids(page())).toEqual([a.id]);
  });
});
