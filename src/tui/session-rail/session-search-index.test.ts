import { describe, expect, it, vi } from "vitest";

import type { SessionPickerEntry } from "../tui-state.js";
import { createIndexedSessionPickerSearch, type IndexedSessionHit } from "./session-search.js";
import {
  createSessionPickerSearchIndex,
  SYNC_MAX_TICKS,
  SYNC_SESSIONS_PER_TICK,
} from "./session-search-index.js";

/**
 * ATO-1659: the picker's search index is built once per list, a few
 * sessions per tick, and every query after that reuses it.
 */

function entry(id: string, preview: string, updatedAt = 1): SessionPickerEntry {
  return { sessionId: id, workingDir: "/tmp/w", turnCount: 1, stepCount: 1, updatedAt, preview, pinned: false };
}

const lines: Record<string, { text: string }[]> = {
  "s-1": [{ text: "plan the trip" }, { text: "Book the train to Lisbon on Friday." }],
  "s-2": [{ text: "fix the login bug" }, { text: "The cookie was not set." }],
  "s-3": [],
};

const hitsFor = (query: string): IndexedSessionHit[] =>
  query.includes("train")
    ? [
        { sessionId: "s-1", workingDir: "/tmp/w", updatedAt: 1, snippet: "the «train»" },
        { sessionId: "s-9", workingDir: "/tmp/old", updatedAt: 5, snippet: "an old «train» ticket" },
      ]
    : [];

function manualScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (task: () => void) => {
      queue.push(task);
    },
    flush: () => {
      let guard = 0;
      while (queue.length > 0 && guard++ < 10_000) queue.shift()?.();
    },
    pending: () => queue.length,
  };
}

function setup() {
  const ticks = manualScheduler();
  const sync = vi.fn((_budget: number) => 0);
  const match = vi.fn((query: string) => hitsFor(query));
  const source = vi.fn((id: string) => lines[id] ?? []);
  const index = createSessionPickerSearchIndex({ index: { sync, match }, source, schedule: ticks.schedule });
  return { ticks, sync, match, source, index };
}

const ids = (rows: readonly SessionPickerEntry[]) => rows.map((r) => r.sessionId);
const list = [entry("s-1", "Trip plan"), entry("s-2", "Login bug"), entry("s-3", "Empty")];

describe("createSessionPickerSearchIndex", () => {
  it("builds the index once and reuses it across many queries", () => {
    const { ticks, sync, match, source, index } = setup();
    expect(index.search(list, "c")).toEqual([]);
    ticks.flush();
    const queries = ["c", "co", "coo", "cook", "cooki", "cookie", "cooki", "lisbon", "train"];
    for (const query of queries) index.search(list, query);
    // One sync for the whole list, one transcript read per session, and
    // never a store read inside a query.
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(SYNC_SESSIONS_PER_TICK);
    expect(source).toHaveBeenCalledTimes(list.length);
    // One FTS5 read per distinct query, none repeated.
    expect(match).toHaveBeenCalledTimes(new Set(queries).size);
    expect(ticks.pending()).toBe(0);
  });

  it("gives the same answers as the per-query search over the same store", () => {
    const { ticks, index } = setup();
    const before = createIndexedSessionPickerSearch(hitsFor, (id) => lines[id] ?? []);
    for (const query of ["trip", "LOGIN", "cookie", "lisbon", "train", "zzz", "  set "]) {
      index.search(list, query);
      ticks.flush();
      expect(index.search(list, query)).toEqual(before(list, query));
    }
    expect(ids(index.search(list, "train"))).toEqual(["s-1", "s-9"]);
  });

  it("answers nothing and says it is building until the build is done", () => {
    const { ticks, index } = setup();
    const listener = vi.fn();
    index.subscribe(listener);
    expect(index.building(list, "")).toBe(false);
    expect(index.search(list, "")).toBe(list);
    expect(index.building(list, "cookie")).toBe(true);
    expect(index.search(list, "cookie")).toEqual([]);
    const version = index.version();
    ticks.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(index.version()).not.toBe(version);
    expect(index.building(list, "cookie")).toBe(false);
    expect(ids(index.search(list, "cookie"))).toEqual(["s-2"]);
  });

  it("does the work in ticks, not inside the query", () => {
    const { ticks, sync, source, index } = setup();
    index.search(list, "cookie");
    expect(sync).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(ticks.pending()).toBe(1);
  });

  it("rebuilds for a new list, rereading only the sessions that changed", () => {
    const { ticks, sync, source, index } = setup();
    index.search(list, "cookie");
    ticks.flush();
    // The same list again is the same index.
    index.search(list, "lisbon");
    expect(index.building(list, "lisbon")).toBe(false);
    // A chat was touched and another made: the rail emits a new list.
    const changed = [entry("s-4", "New chat"), entry("s-1", "Trip plan", 2), list[1]!, list[2]!];
    expect(index.building(changed, "cookie")).toBe(true);
    expect(index.search(changed, "cookie")).toEqual([]);
    ticks.flush();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenCalledTimes(list.length + 2);
    expect(source.mock.calls.slice(list.length).map(([id]) => id)).toEqual(["s-4", "s-1"]);
    expect(ids(index.search(changed, "cookie"))).toEqual(["s-2"]);
  });

  it("asks the FTS5 index afresh after a rebuild", () => {
    const { ticks, match, index } = setup();
    index.search(list, "train");
    ticks.flush();
    index.search(list, "train");
    const reopened = [...list];
    index.search(reopened, "train");
    ticks.flush();
    index.search(reopened, "train");
    expect(match).toHaveBeenCalledTimes(2);
  });

  it("drops a build that a newer list replaced", () => {
    const { ticks, source, index } = setup();
    index.search([entry("s-1", "Trip plan")], "x");
    index.search([entry("s-2", "Login bug")], "x");
    ticks.flush();
    expect(source.mock.calls.map(([id]) => id)).toEqual(["s-2"]);
  });

  it("syncs in rounds until nothing is left, and stops at the old per-search budget", () => {
    const ticks = manualScheduler();
    let left = 60;
    const sync = vi.fn((budget: number) => (left = Math.max(0, left - budget)));
    const index = createSessionPickerSearchIndex({ index: { sync, match: () => [] }, schedule: ticks.schedule });
    index.search(list, "x");
    ticks.flush();
    expect(sync).toHaveBeenCalledTimes(3);

    const stuck = vi.fn(() => 99);
    const other = createSessionPickerSearchIndex({ index: { sync: stuck, match: () => [] }, schedule: ticks.schedule });
    other.search(list, "x");
    ticks.flush();
    expect(stuck).toHaveBeenCalledTimes(SYNC_MAX_TICKS);
    expect(other.building(list, "x")).toBe(false);
  });

  it("falls back to the loaded list when the index cannot sync or answer", () => {
    const ticks = manualScheduler();
    const index = createSessionPickerSearchIndex({
      index: {
        sync: () => {
          throw new Error("no fts5");
        },
        match: () => {
          throw new Error("no fts5");
        },
      },
      source: (id) => lines[id] ?? [],
      schedule: ticks.schedule,
    });
    index.search(list, "lisbon");
    ticks.flush();
    expect(ids(index.search(list, "lisbon"))).toEqual(["s-1"]);
  });
});
