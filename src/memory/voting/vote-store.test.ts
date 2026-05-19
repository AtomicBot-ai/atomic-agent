import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type DatabaseT from "better-sqlite3";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { applyMigrations } from "../memory-schema.js";
import { VoteStore, VoteValidationError } from "./vote-store.js";

interface Fixture {
  db: DatabaseT.Database;
  store: VoteStore;
  cleanup: () => void;
  clock: { now: number };
  seedMemory: (content?: string) => number;
  seedLesson: (activation?: string) => number;
  seedProfileFact: (key: string, value: string) => number;
}

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "atomic-agent-vote-"));
  const db = new DatabaseCtor(join(tmp, "memory.sqlite"));
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  const clock = { now: 1_000_000 };
  const store = new VoteStore({ db, now: () => clock.now });

  const insertMemory = db.prepare(
    `INSERT INTO memories (content, created_at, updated_at, source)
     VALUES (?, ?, ?, 'agent')
     RETURNING id`,
  );
  const insertLesson = db.prepare(
    `INSERT INTO lessons
       (activation, principle, parent_ids, created_at, updated_at)
     VALUES (?, 'principle text', '[1]', ?, ?)
     RETURNING id`,
  );
  const insertProfile = db.prepare(
    `INSERT INTO profile_facts
       (key, value, valid_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  );

  return {
    db,
    store,
    clock,
    seedMemory: (content = "note body") =>
      (insertMemory.get(content, clock.now, clock.now) as { id: number }).id,
    seedLesson: (activation = "when X") =>
      (insertLesson.get(activation, clock.now, clock.now) as { id: number })
        .id,
    seedProfileFact: (key, value) =>
      (
        insertProfile.get(key, value, clock.now, clock.now, clock.now) as {
          id: number;
        }
      ).id,
    cleanup: () => {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("VoteStore", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  describe("applyVote", () => {
    it("upvotes a memory and writes one audit row", () => {
      const id = f.seedMemory();
      const result = f.store.applyVote({
        kind: "memory",
        targetId: id,
        direction: 1,
        maxVotePerItem: 50,
        sessionId: "sess-1",
        turnIndex: 4,
      });
      expect(result).toMatchObject({
        status: "applied",
        previousScore: 0,
        newScore: 1,
      });
      expect(f.store.getScore("memory", id)).toBe(1);
      expect(f.store.getEventCount()).toBe(1);
      const [event] = f.store.listEvents();
      expect(event).toMatchObject({
        kind: "memory",
        targetId: id,
        direction: 1,
        sessionId: "sess-1",
        turnIndex: 4,
      });
    });

    it("downvote subtracts one and clamps at -max", () => {
      const id = f.seedLesson();
      for (let i = 0; i < 3; i++) {
        f.store.applyVote({
          kind: "lesson",
          targetId: id,
          direction: -1,
          maxVotePerItem: 3,
        });
      }
      expect(f.store.getScore("lesson", id)).toBe(-3);
      // Fourth downvote — already at clamp, must reject without
      // writing an audit row (scorecard 7a.C.2).
      const fourth = f.store.applyVote({
        kind: "lesson",
        targetId: id,
        direction: -1,
        maxVotePerItem: 3,
      });
      expect(fourth).toEqual({ status: "clamp_hit", currentScore: -3 });
      expect(f.store.getScore("lesson", id)).toBe(-3);
      expect(f.store.getEventCount()).toBe(3);
    });

    // Scorecard 7a.C.1 — clamp at +max, not +max+1.
    it("clamp respects maxVotePerItem (scorecard 7a.C.1)", () => {
      const id = f.seedLesson();
      for (let i = 0; i < 49; i++) {
        f.store.applyVote({
          kind: "lesson",
          targetId: id,
          direction: 1,
          maxVotePerItem: 50,
        });
      }
      expect(f.store.getScore("lesson", id)).toBe(49);
      f.store.applyVote({
        kind: "lesson",
        targetId: id,
        direction: 1,
        maxVotePerItem: 50,
      });
      expect(f.store.getScore("lesson", id)).toBe(50);
      const clamped = f.store.applyVote({
        kind: "lesson",
        targetId: id,
        direction: 1,
        maxVotePerItem: 50,
      });
      expect(clamped).toEqual({ status: "clamp_hit", currentScore: 50 });
      expect(f.store.getScore("lesson", id)).toBe(50);
      expect(f.store.getEventCount()).toBe(50);
    });

    it("returns target_missing for an unknown id without writing the audit log", () => {
      const result = f.store.applyVote({
        kind: "memory",
        targetId: 99999,
        direction: 1,
        maxVotePerItem: 10,
      });
      expect(result).toEqual({
        status: "target_missing",
        kind: "memory",
        targetId: 99999,
      });
      expect(f.store.getEventCount()).toBe(0);
    });

    it("routes votes to the correct table per kind", () => {
      const memId = f.seedMemory();
      const lessonId = f.seedLesson();
      const profileId = f.seedProfileFact("language", "ru");

      f.store.applyVote({
        kind: "memory",
        targetId: memId,
        direction: 1,
        maxVotePerItem: 10,
      });
      f.store.applyVote({
        kind: "lesson",
        targetId: lessonId,
        direction: -1,
        maxVotePerItem: 10,
      });
      f.store.applyVote({
        kind: "profile",
        targetId: profileId,
        direction: -1,
        maxVotePerItem: 10,
      });

      expect(f.store.getScore("memory", memId)).toBe(1);
      expect(f.store.getScore("lesson", lessonId)).toBe(-1);
      expect(f.store.getScore("profile", profileId)).toBe(-1);
      expect(f.store.getEventCount()).toBe(3);
    });

    it("rejects malformed input (kind / direction / clamp / id)", () => {
      const id = f.seedMemory();
      expect(() =>
        f.store.applyVote({
          kind: "bogus" as never,
          targetId: id,
          direction: 1,
          maxVotePerItem: 10,
        }),
      ).toThrow(VoteValidationError);
      expect(() =>
        f.store.applyVote({
          kind: "memory",
          targetId: id,
          direction: 0 as never,
          maxVotePerItem: 10,
        }),
      ).toThrow(/direction/);
      expect(() =>
        f.store.applyVote({
          kind: "memory",
          targetId: id,
          direction: 1,
          maxVotePerItem: 0,
        }),
      ).toThrow(/maxVotePerItem/);
      expect(() =>
        f.store.applyVote({
          kind: "memory",
          targetId: -1,
          direction: 1,
          maxVotePerItem: 10,
        }),
      ).toThrow(/targetId/);
    });
  });

  describe("decayAllScores", () => {
    it("scales every non-zero score by the factor in one transaction", () => {
      const memId = f.seedMemory();
      const lessonId = f.seedLesson();
      const profileId = f.seedProfileFact("language", "ru");
      f.store.applyVote({
        kind: "memory",
        targetId: memId,
        direction: 1,
        maxVotePerItem: 50,
      });
      f.store.applyVote({
        kind: "lesson",
        targetId: lessonId,
        direction: 1,
        maxVotePerItem: 50,
      });
      f.store.applyVote({
        kind: "lesson",
        targetId: lessonId,
        direction: 1,
        maxVotePerItem: 50,
      });
      f.store.applyVote({
        kind: "profile",
        targetId: profileId,
        direction: -1,
        maxVotePerItem: 50,
      });
      const result = f.store.decayAllScores(0.5);
      expect(result).toEqual({
        memories: 1,
        lessons: 1,
        profileFacts: 1,
        procedures: 0,
      });
      expect(f.store.getScore("memory", memId)).toBeCloseTo(0.5);
      expect(f.store.getScore("lesson", lessonId)).toBeCloseTo(1);
      expect(f.store.getScore("profile", profileId)).toBeCloseTo(-0.5);
    });

    // Scorecard 7a.D.4 — bulk SQL, no per-row JS round-trip. We assert
    // observable behaviour: 1000 rows updated, runtime budget that
    // would be infeasible if we round-tripped per row.
    it("decays 1000 rows in bulk SQL within a single transaction (scorecard 7a.D.4)", () => {
      const ids: number[] = [];
      for (let i = 0; i < 1000; i++) {
        ids.push(f.seedMemory(`note ${i}`));
      }
      for (const id of ids) {
        f.store.applyVote({
          kind: "memory",
          targetId: id,
          direction: 1,
          maxVotePerItem: 50,
        });
      }
      const start = Date.now();
      const result = f.store.decayAllScores(0.9);
      const durationMs = Date.now() - start;
      expect(result.memories).toBe(1000);
      // 1000 rows in well under a second on any reasonable hardware
      // — the wall-clock cap is loose enough not to flake on shared
      // CI runners but tight enough that an N+1 regression would
      // blow past it.
      expect(durationMs).toBeLessThan(1000);
      const allScores = f.db
        .prepare(`SELECT vote_score FROM memories`)
        .all() as Array<{ vote_score: number }>;
      expect(allScores.every((r) => Math.abs(r.vote_score - 0.9) < 1e-6)).toBe(
        true,
      );
    });

    it("skips rows whose score is already zero (no unnecessary writes)", () => {
      f.seedMemory();
      f.seedMemory();
      const result = f.store.decayAllScores(0.5);
      expect(result.memories).toBe(0);
    });

    it("clamps the factor defensively to [0, 1]", () => {
      const id = f.seedMemory();
      f.store.applyVote({
        kind: "memory",
        targetId: id,
        direction: 1,
        maxVotePerItem: 50,
      });
      f.store.decayAllScores(1.5);
      expect(f.store.getScore("memory", id)).toBe(1);
      f.store.decayAllScores(-0.5);
      expect(f.store.getScore("memory", id)).toBe(0);
    });
  });

  describe("FIFO eviction", () => {
    it("evicts oldest audit rows past the cap (lazy, inside applyVote)", () => {
      const id = f.seedMemory();
      // Six votes; cap at 3. Alternate up/down so each one writes
      // an audit row (no clamp_hit short-circuit).
      for (let i = 0; i < 6; i++) {
        f.clock.now += 10;
        f.store.applyVote({
          kind: "memory",
          targetId: id,
          direction: i % 2 === 0 ? 1 : -1,
          maxVotePerItem: 50,
          eventLogMaxRows: 3,
        });
      }
      expect(f.store.getEventCount()).toBe(3);
      const events = f.store.listEvents().sort((a, b) => a.id - b.id);
      // The three remaining events must be the three newest by id.
      expect(events.map((e) => e.id)).toEqual([4, 5, 6]);
    });

    it("does not evict when eventLogMaxRows = 0", () => {
      const id = f.seedLesson();
      for (let i = 0; i < 5; i++) {
        f.clock.now += 10;
        f.store.applyVote({
          kind: "lesson",
          targetId: id,
          direction: i % 2 === 0 ? 1 : -1,
          maxVotePerItem: 50,
          eventLogMaxRows: 0,
        });
      }
      expect(f.store.getEventCount()).toBe(5);
    });

    it("evictOldestEvents is idempotent when under the cap", () => {
      const id = f.seedMemory();
      f.store.applyVote({
        kind: "memory",
        targetId: id,
        direction: 1,
        maxVotePerItem: 50,
      });
      expect(f.store.evictOldestEvents(100)).toBe(0);
      expect(f.store.getEventCount()).toBe(1);
    });
  });
});
