import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import {
  readSessionPins,
  readTaskPinnedSessionIds,
  readWebhookPinnedSessionIds,
} from "./session-pins.js";
import { pruneSessions } from "./session-retention.js";
import { SessionStore } from "./session-store.js";
import type { SessionStatus } from "./session-state.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

interface SeedRow {
  id: string;
  /** Age in days at `NOW`. */
  ageDays: number;
  status?: SessionStatus;
  turnCount?: number;
  /** Stored verbatim — the way an unreadable row is made. */
  payload?: string;
}

describe("pruneSessions", () => {
  let tmp: string;
  let store: SessionStore;
  let db: Database.Database;
  let tracesDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-retention-"));
    tracesDir = join(tmp, "traces");
    mkdirSync(tracesDir, { recursive: true });
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
    db = store.getDatabaseHandleForRetention();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed(...rows: SeedRow[]): void {
    const insert = db.prepare(
      `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const at = NOW - row.ageDays * DAY;
      const payload =
        row.payload ??
        JSON.stringify({
          id: row.id,
          turns: [],
          turnCount: row.turnCount ?? 3,
        });
      insert.run(row.id, "/work", row.status ?? "pending", payload, at, at);
    }
  }

  function remaining(): string[] {
    return (db.prepare(`SELECT id FROM sessions ORDER BY id`).all() as {
      id: string;
    }[]).map((row) => row.id);
  }

  function writeTrace(id: string): string {
    const path = join(tracesDir, `${id}.ndjson`);
    writeFileSync(path, `{"sessionId":"${id}"}\n`, "utf8");
    return path;
  }

  /** A `tasks.sqlite` with only what the pinned-session read touches. */
  function seedTasks(sessionIds: (string | null)[]): string {
    const file = join(tmp, "tasks.sqlite");
    const tasks = new DatabaseCtor(file);
    tasks.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT)`);
    const insert = tasks.prepare(
      `INSERT INTO tasks (id, session_id) VALUES (?, ?)`,
    );
    sessionIds.forEach((sessionId, index) =>
      insert.run(`task-${index}`, sessionId),
    );
    tasks.close();
    return file;
  }

  /** `webhook-sessions.json` as `WebhookSessionStore` writes it. */
  function seedWebhooks(map: Record<string, unknown> | string): string {
    const file = join(tmp, "webhook-sessions.json");
    writeFileSync(
      file,
      typeof map === "string" ? map : JSON.stringify(map),
      "utf8",
    );
    return file;
  }

  function prune(
    overrides: Partial<Parameters<typeof pruneSessions>[0]> = {},
  ): ReturnType<typeof pruneSessions> {
    return pruneSessions({
      db,
      maxAgeDays: null,
      maxRows: null,
      now: NOW,
      tracesDir,
      ...overrides,
    });
  }

  it("deletes rows older than maxAgeDays and leaves the rest", () => {
    seed(
      { id: "ancient", ageDays: 400 },
      { id: "old", ageDays: 91 },
      { id: "fresh", ageDays: 89 },
      { id: "today", ageDays: 0 },
    );

    const result = prune({ maxAgeDays: 90 });

    expect(result.deleted).toBe(2);
    expect(remaining()).toEqual(["fresh", "today"]);
  });

  // The age rule is the one the operator can switch off; the housekeeping
  // rules below it are not knobs.
  it("touches nothing when both caps are null and every row is a real session", () => {
    seed({ id: "ancient", ageDays: 400 }, { id: "today", ageDays: 0 });

    const result = prune();

    expect(result).toEqual({
      deleted: 0,
      orphans: 0,
      unreadable: 0,
      tracesRemoved: 0,
      vacuumed: false,
    });
    expect(remaining()).toEqual(["ancient", "today"]);
  });

  it("enforces maxRows oldest-first", () => {
    seed(
      { id: "d5", ageDays: 5 },
      { id: "d4", ageDays: 4 },
      { id: "d3", ageDays: 3 },
      { id: "d2", ageDays: 2 },
      { id: "d1", ageDays: 1 },
    );

    const result = prune({ maxRows: 2 });

    expect(result.deleted).toBe(3);
    expect(remaining()).toEqual(["d1", "d2"]);
  });

  it("never deletes a session with a live status", () => {
    seed(
      { id: "running", ageDays: 400, status: "running" },
      { id: "approval", ageDays: 400, status: "awaiting_approval" },
      { id: "llm", ageDays: 400, status: "awaiting_llm" },
      { id: "done", ageDays: 400, status: "completed" },
      { id: "stalled", ageDays: 400, status: "stalled" },
    );

    const result = prune({ maxAgeDays: 90, maxRows: 1 });

    expect(result.deleted).toBe(2);
    expect(remaining()).toEqual(["approval", "llm", "running"]);
  });

  // A live status also outranks the row cap, which would otherwise take
  // the oldest rows in the table — the running one among them.
  it("stops short of the row cap rather than deleting an exempt row", () => {
    seed(
      { id: "busy", ageDays: 400, status: "running" },
      { id: "idle", ageDays: 399 },
    );

    expect(prune({ maxRows: 0 }).deleted).toBe(1);
    expect(remaining()).toEqual(["busy"]);
  });

  it("honours keepSessionIds from the caller", () => {
    seed({ id: "held", ageDays: 400 }, { id: "loose", ageDays: 400 });

    const result = prune({ maxAgeDays: 90, keepSessionIds: ["held"] });

    expect(result.deleted).toBe(1);
    expect(remaining()).toEqual(["held"]);
  });

  // The two things outside this table that point at a session by id, fed
  // in through the one seam the prune has for them.
  describe("pins read off disk", () => {
    it("never deletes a session a scheduled task points at", () => {
      seed({ id: "pinned", ageDays: 400 }, { id: "loose", ageDays: 400 });
      const tasksDbFile = seedTasks(["pinned", null]);

      const result = prune({
        maxAgeDays: 90,
        keepSessionIds: readSessionPins({ tasksDbFile }),
      });

      expect(result.deleted).toBe(1);
      expect(remaining()).toEqual(["pinned"]);
    });

    it("never deletes a session a persistent webhook binding reuses", () => {
      seed({ id: "hooked", ageDays: 400 }, { id: "loose", ageDays: 400 });
      const webhookSessionsFile = seedWebhooks({ deploy: "hooked" });

      const result = prune({
        maxAgeDays: 90,
        keepSessionIds: readSessionPins({ webhookSessionsFile }),
      });

      expect(result.deleted).toBe(1);
      expect(remaining()).toEqual(["hooked"]);
    });

    it("collects both sources at once, deduped", () => {
      seed(
        { id: "both", ageDays: 400 },
        { id: "task-only", ageDays: 400 },
        { id: "hook-only", ageDays: 400 },
        { id: "loose", ageDays: 400 },
      );
      const pins = readSessionPins({
        tasksDbFile: seedTasks(["both", "task-only"]),
        webhookSessionsFile: seedWebhooks({ a: "both", b: "hook-only" }),
      });
      expect(pins.sort()).toEqual(["both", "hook-only", "task-only"]);

      const result = prune({ maxAgeDays: 90, keepSessionIds: pins });

      expect(result.deleted).toBe(1);
      expect(remaining()).toEqual(["both", "hook-only", "task-only"]);
    });

    // A binding can already point at nothing — the operator deleted the
    // session by hand. The id pins a row that is not there, which is not
    // an error and must not stop the rest of the prune.
    it("prunes around a binding that points at an already-missing session", () => {
      seed({ id: "loose", ageDays: 400 });
      const webhookSessionsFile = seedWebhooks({ deploy: "s-long-gone" });

      const result = prune({
        maxAgeDays: 90,
        keepSessionIds: readSessionPins({ webhookSessionsFile }),
      });

      expect(result.deleted).toBe(1);
      expect(remaining()).toEqual([]);
    });

    it("reads no pins from files that are absent, corrupt or the wrong shape", () => {
      const webhookPins = (map: Record<string, unknown> | string): string[] =>
        readWebhookPinnedSessionIds(seedWebhooks(map));

      expect(readSessionPins({})).toEqual([]);
      expect(readTaskPinnedSessionIds(join(tmp, "no-such.sqlite"))).toEqual([]);
      expect(readWebhookPinnedSessionIds(join(tmp, "no-such.json"))).toEqual([]);
      // Half-written JSON, a JSON array, and entries that are not ids:
      // `WebhookSessionStore` reads each of these as an empty map too.
      expect(webhookPins('{"deploy": "s1')).toEqual([]);
      expect(webhookPins('["s1"]')).toEqual([]);
      expect(webhookPins({ a: "", b: 7, c: null })).toEqual([]);
    });

    it("reads no pins from a tasks.sqlite with no tasks table", () => {
      const file = join(tmp, "empty-tasks.sqlite");
      const empty = new DatabaseCtor(file);
      empty.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY)`);
      empty.close();

      expect(readTaskPinnedSessionIds(file)).toEqual([]);

      seed({ id: "loose", ageDays: 400 });
      expect(
        prune({
          maxAgeDays: 90,
          keepSessionIds: readSessionPins({ tasksDbFile: file }),
        }).deleted,
      ).toBe(1);
    });
  });

  it("deletes turnCount = 0 rows past the grace period, not inside it", () => {
    seed(
      { id: "unused-old", ageDays: 2, turnCount: 0 },
      { id: "unused-now", ageDays: 0, turnCount: 0 },
      { id: "used-old", ageDays: 2, turnCount: 1 },
    );

    const result = prune();

    expect(result.orphans).toBe(1);
    expect(result.deleted).toBe(1);
    expect(remaining()).toEqual(["unused-now", "used-old"]);
  });

  it("deletes unreadable rows past the grace period, not inside it", () => {
    seed(
      { id: "broken-old", ageDays: 2, payload: "{not json" },
      { id: "broken-now", ageDays: 0, payload: "{not json" },
    );
    expect(store.countUnreadable()).toBe(2);

    const result = prune();

    expect(result.unreadable).toBe(1);
    expect(result.orphans).toBe(0);
    expect(remaining()).toEqual(["broken-now"]);
  });

  // `json_extract` raises on a payload that is not JSON, so the orphan
  // rule and the unreadable rule must not collide on the same row.
  it("does not let an unreadable payload break the orphan rule", () => {
    seed(
      { id: "broken", ageDays: 2, payload: "" },
      { id: "unused", ageDays: 2, turnCount: 0 },
    );

    const result = prune();

    expect(result.unreadable).toBe(1);
    expect(result.orphans).toBe(1);
    expect(remaining()).toEqual([]);
  });

  it("removes the trace file of every pruned session and only those", () => {
    seed({ id: "gone", ageDays: 400 }, { id: "kept", ageDays: 1 });
    const gonePath = writeTrace("gone");
    const keptPath = writeTrace("kept");
    // A session whose tracing was off has no file; that is not an error.
    seed({ id: "untraced", ageDays: 400 });

    const result = prune({ maxAgeDays: 90 });

    expect(result.deleted).toBe(2);
    expect(result.tracesRemoved).toBe(1);
    expect(existsSync(gonePath)).toBe(false);
    expect(existsSync(keptPath)).toBe(true);
  });

  it("leaves trace files alone when no traces dir is given", () => {
    seed({ id: "gone", ageDays: 400 });
    const path = writeTrace("gone");

    const result = prune({ maxAgeDays: 90, tracesDir: null });

    expect(result.tracesRemoved).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("deletes a fixture larger than one batch, in more than one statement", () => {
    const rows: SeedRow[] = [];
    for (let i = 0; i < 1_201; i += 1) {
      rows.push({ id: `s${String(i).padStart(4, "0")}`, ageDays: 400 });
    }
    seed(...rows);
    const counter = countingDeletes(db);

    const result = pruneSessions({
      db: counter.db,
      maxAgeDays: 90,
      maxRows: null,
      now: NOW,
      tracesDir,
    });

    expect(result.deleted).toBe(1_201);
    expect(remaining()).toEqual([]);
    // 1201 rows at 500 a statement is three deletes, not one.
    expect(counter.deletes()).toBe(3);
  });

  it("does not vacuum when the prune freed nothing", () => {
    seed({ id: "today", ageDays: 0 });

    expect(prune({ maxAgeDays: 90 }).vacuumed).toBe(false);
  });

  it("does not vacuum a file too small for the rewrite to pay off", () => {
    seed({ id: "old", ageDays: 400 });

    const result = prune({ maxAgeDays: 90 });

    expect(result.deleted).toBe(1);
    expect(result.vacuumed).toBe(false);
  });

  it("vacuums once the freed space is worth reclaiming", () => {
    const filler = "x".repeat(8 * 1024);
    for (let i = 0; i < 700; i += 1) {
      seed({
        id: `big${i}`,
        ageDays: 400,
        payload: JSON.stringify({ turnCount: 1, filler }),
      });
    }
    const before = db.pragma("page_count", { simple: true }) as number;
    expect(before).toBeGreaterThan(512);

    const result = prune({ maxAgeDays: 90 });

    expect(result.deleted).toBe(700);
    expect(result.vacuumed).toBe(true);
    expect(db.pragma("page_count", { simple: true }) as number).toBeLessThan(
      before,
    );
  });
});

/**
 * Wrap a handle so the test can count how many DELETE statements actually
 * ran — the difference between "the rows are gone" and "the rows are gone
 * in bounded batches", which is the whole point of the loop.
 */
function countingDeletes(db: Database.Database): {
  db: Database.Database;
  deletes: () => number;
} {
  let deletes = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver): unknown {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string): unknown => {
        const statement = target.prepare(sql);
        if (!/^\s*DELETE/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, innerProp, innerReceiver): unknown {
            if (innerProp !== "run") {
              return Reflect.get(inner, innerProp, innerReceiver);
            }
            return (...params: unknown[]): unknown => {
              deletes += 1;
              return inner.run(...params);
            };
          },
        });
      };
    },
  });
  return { db: wrapped, deletes: () => deletes };
}
