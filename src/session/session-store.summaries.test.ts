import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, recordTurn } from "./session-state.js";
import { userTurn, assistantReplyTurn } from "./conversation-turn.js";
import { summarizeSessionState } from "./session-summary.js";
import { sessionSummaryCursorAfter } from "./session-summary-page.js";

/**
 * Write a row the store itself would never write, through a second
 * handle on the same file: the store has no API for a broken payload,
 * and that is the point — the rows come from a truncated write or a
 * hand edit, not from `save`.
 */
function insertRaw(
  file: string,
  id: string,
  payload: string,
  updatedAt: number,
) {
  const raw = new DatabaseCtor(file);
  try {
    raw
      .prepare(
        `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
         VALUES (?, '/raw', 'pending', ?, ?, ?)`,
      )
      .run(id, payload, updatedAt, updatedAt);
  } finally {
    raw.close();
  }
}

/** A session someone has spoken to, stamped at `updatedAt`. */
function spokenTo(id: string, text: string, updatedAt: number) {
  return {
    ...recordTurn(
      createEmptySessionState({ id, workingDir: "/w" }),
      userTurn(text),
    ),
    updatedAt,
  };
}

describe("SessionStore.listSummaryPage", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-summ-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] on an empty table", () => {
    expect(store.listSummaryPage({ limit: 25 })).toEqual([]);
    expect(store.countUnreadable()).toBe(0);
  });

  it("lists sessions newest first with the first prompt lifted out", () => {
    const a = recordTurn(
      createEmptySessionState({ id: "a", workingDir: "/w" }),
      userTurn("first thing said"),
    );
    const b = recordTurn(
      recordTurn(
        createEmptySessionState({ id: "b", workingDir: "/w" }),
        userTurn("hello"),
      ),
      assistantReplyTurn("hi"),
    );
    store.save({ ...a, updatedAt: 1000, turnCount: 3, stepCount: 7 });
    store.save({ ...b, updatedAt: 3000 });
    const rows = store.listSummaryPage({ limit: 25 });
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[1]).toMatchObject({
      id: "a",
      workingDir: "/w",
      status: "pending",
      updatedAt: 1000,
      turnCount: 3,
      stepCount: 7,
      firstPrompt: "first thing said",
      importedFrom: null,
    });
    expect(rows[0]?.firstPrompt).toBe("hello");
  });

  it("leaves out a session nobody has spoken to, and keeps an empty prompt", () => {
    // `+ new` and every scheduled task persist an unnamed row. They are
    // filtered in SQL, so a page of `limit` rows is `limit` threads;
    // an empty string is still a prompt and keeps its row.
    const unnamed = createEmptySessionState({ id: "u", workingDir: "/w" });
    store.save({ ...unnamed, updatedAt: 1 });
    store.save(spokenTo("e", "", 2));
    const rows = store.listSummaryPage({ limit: 25 });
    expect(rows.map((r) => r.id)).toEqual(["e"]);
    expect(rows[0]?.firstPrompt).toBe("");
  });

  it("reads importedFrom out of the metadata", () => {
    const s = recordTurn(
      createEmptySessionState({
        id: "imp",
        workingDir: "/w",
        metadata: { importedFrom: "hermes" },
      }),
      userTurn("imported thread"),
    );
    store.save(s);
    expect(store.listSummaryPage({ limit: 25 })[0]?.importedFrom).toBe(
      "hermes",
    );
  });

  it("agrees with summarizeSessionState on a saved state", () => {
    const s = recordTurn(
      createEmptySessionState({
        id: "same",
        workingDir: "/w",
        metadata: { importedFrom: "codex" },
      }),
      userTurn("prompt"),
    );
    const saved = {
      ...s,
      updatedAt: 42,
      createdAt: 41,
      turnCount: 1,
      stepCount: 2,
    };
    store.save(saved);
    expect(store.listSummaryPage({ limit: 25 })[0]).toEqual(
      summarizeSessionState(saved),
    );
  });

  it("skips a corrupt payload row and counts it as unreadable", () => {
    store.save(spokenTo("ok", "said something", 1));
    insertRaw(file, "bad", '{"id":"bad","turns":[', 9999);
    expect(store.listSummaryPage({ limit: 25 }).map((r) => r.id)).toEqual([
      "ok",
    ]);
    expect(store.countUnreadable()).toBe(1);
  });

  it("leaves out a payload with no turns array, without counting it unreadable", () => {
    store.save(spokenTo("ok", "said something", 1));
    insertRaw(file, "empty-object", "{}", 5000);
    insertRaw(file, "string-turns", '{"id":"string-turns","turns":"x"}', 6000);
    expect(store.listSummaryPage({ limit: 25 }).map((r) => r.id)).toEqual([
      "ok",
    ]);
    expect(store.countUnreadable()).toBe(0);
  });

  it("coerces missing counts to 0 and non-object turns to no prompt", () => {
    insertRaw(
      file,
      "thin",
      '{"id":"thin","turns":[1,"two",{"kind":"user","text":"three"}]}',
      1,
    );
    const [row] = store.listSummaryPage({ limit: 25 });
    expect(row).toMatchObject({
      turnCount: 0,
      stepCount: 0,
      firstPrompt: "three",
    });
  });

  it("stops at the limit, and hands back nothing for a limit of 0", () => {
    for (let i = 0; i < 5; i += 1) {
      store.save(spokenTo(`s-${i}`, `thread ${i}`, 1000 + i));
    }
    expect(store.listSummaryPage({ limit: 2 }).map((r) => r.id)).toEqual([
      "s-4",
      "s-3",
    ]);
    // SQLite reads `LIMIT -1` as no limit at all, so a non-positive
    // limit must never reach it as it was written.
    expect(store.listSummaryPage({ limit: 0 })).toEqual([]);
    expect(store.listSummaryPage({ limit: -1 })).toEqual([]);
  });
});

describe("SessionStore.listSummaryPage — the walk", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-page-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Walk the whole table one page at a time; the ids, in order. */
  function walk(limit: number): string[] {
    const ids: string[] = [];
    let after = undefined as
      ReturnType<typeof sessionSummaryCursorAfter> | undefined;
    for (;;) {
      const page = store.listSummaryPage({
        limit,
        ...(after ? { after } : {}),
      });
      for (const row of page) ids.push(row.id);
      if (page.length < limit) return ids;
      after = sessionSummaryCursorAfter(page) ?? undefined;
      // A page that cannot produce a cursor cannot be resumed; bail
      // rather than loop forever if that ever becomes possible.
      if (!after) return ids;
    }
  }

  it("resumes from the cursor with no row skipped or repeated", () => {
    for (let i = 0; i < 9; i += 1) {
      store.save(spokenTo(`s-${i}`, `thread ${i}`, 1000 + i));
    }
    const first = store.listSummaryPage({ limit: 4 });
    expect(first.map((r) => r.id)).toEqual(["s-8", "s-7", "s-6", "s-5"]);
    const second = store.listSummaryPage({
      limit: 4,
      after: sessionSummaryCursorAfter(first)!,
    });
    expect(second.map((r) => r.id)).toEqual(["s-4", "s-3", "s-2", "s-1"]);
    const third = store.listSummaryPage({
      limit: 4,
      after: sessionSummaryCursorAfter(second)!,
    });
    expect(third.map((r) => r.id)).toEqual(["s-0"]);
  });

  it("ends on an empty page when the rows divide exactly by the limit", () => {
    // The boundary the walk has to get right: eight rows in pages of
    // four end with a FULL page, so "short page means done" is not
    // enough on its own — the next page has to come back empty rather
    // than repeat the tail.
    for (let i = 0; i < 8; i += 1) {
      store.save(spokenTo(`s-${i}`, `thread ${i}`, 1000 + i));
    }
    const first = store.listSummaryPage({ limit: 4 });
    const second = store.listSummaryPage({
      limit: 4,
      after: sessionSummaryCursorAfter(first)!,
    });
    expect(second).toHaveLength(4);
    const third = store.listSummaryPage({
      limit: 4,
      after: sessionSummaryCursorAfter(second)!,
    });
    expect(third).toEqual([]);
    expect(walk(4)).toHaveLength(8);
  });

  it("walks a run of rows that share one updated_at exactly once", () => {
    // An import writes its whole batch in one millisecond, and so does
    // a scripted run. A cursor that knew only the timestamp would
    // either skip the rest of the tie or hand it back on every page —
    // the id tiebreak is what makes the boundary land inside it safely.
    for (let i = 0; i < 12; i += 1) {
      store.save(spokenTo(`tie-${String(i).padStart(2, "0")}`, `t ${i}`, 7000));
    }
    const ids = walk(5);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    // Same tie, so `id DESC` is the whole order.
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("walks ties that straddle two timestamps in order", () => {
    store.save(spokenTo("a1", "a1", 2000));
    store.save(spokenTo("a2", "a2", 2000));
    store.save(spokenTo("b1", "b1", 1000));
    store.save(spokenTo("b2", "b2", 1000));
    expect(walk(1)).toEqual(["a2", "a1", "b2", "b1"]);
    expect(walk(2)).toEqual(["a2", "a1", "b2", "b1"]);
    expect(walk(3)).toEqual(["a2", "a1", "b2", "b1"]);
  });

  it("keeps skipping and counting unreadable rows across pages", () => {
    const file = join(tmp, "sessions.sqlite");
    for (let i = 0; i < 6; i += 1) {
      store.save(spokenTo(`s-${i}`, `thread ${i}`, 1000 + i));
    }
    // Interleaved by date, so a corrupt row sits inside every page.
    insertRaw(file, "bad-1", '{"turns":[', 1000);
    insertRaw(file, "bad-2", "not json at all", 1003);
    expect(walk(2)).toEqual(["s-5", "s-4", "s-3", "s-2", "s-1", "s-0"]);
    expect(store.countUnreadable()).toBe(2);
  });

  it("costs the same per page whatever the table holds", () => {
    // 1 000 threads plus the unnamed rows a heavy user accumulates. The
    // claim is not a wall-clock number — it is that one page is `limit`
    // rows and that the LAST page of the walk costs what the first did,
    // which is what an unbounded read could never promise.
    for (let i = 0; i < 1_000; i += 1) {
      store.save(
        spokenTo(`s-${String(i).padStart(4, "0")}`, `thread ${i}`, 1_000 + i),
      );
      if (i % 10 === 0) {
        store.save({
          ...createEmptySessionState({ id: `blank-${i}`, workingDir: "/w" }),
          updatedAt: 1_000 + i,
        });
      }
    }
    const first = store.listSummaryPage({ limit: 40 });
    expect(first).toHaveLength(40);
    expect(first.every((row) => row.firstPrompt !== null)).toBe(true);
    expect(first[0]?.id).toBe("s-0999");

    const firstMs = timed(() => store.listSummaryPage({ limit: 40 }));
    // Walk to the far end of the table and time a page there.
    let after = sessionSummaryCursorAfter(first)!;
    let pages = 1;
    for (;;) {
      const page = store.listSummaryPage({ limit: 40, after });
      if (page.length < 40) break;
      after = sessionSummaryCursorAfter(page)!;
      pages += 1;
    }
    expect(pages).toBe(25);
    const deep = after;
    const deepMs = timed(() =>
      store.listSummaryPage({ limit: 40, after: deep }),
    );
    // Generous: the point is that the deep page is not a whole-table
    // scan, and a scan of 1 100 rows of payload is orders of magnitude
    // dearer than 40 rows, not four times.
    expect(deepMs).toBeLessThan(Math.max(20, firstMs * 4));
  });
});

/** Median of five runs, in ms — a single sample is all jitter. */
function timed(run: () => unknown): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[2] ?? 0;
}
