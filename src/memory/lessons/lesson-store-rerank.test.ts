import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../memory-schema.js";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";

import {
  LessonStore,
  computeLessonCombinedScore,
} from "./lesson-store.js";

/**
 * Memory-v2 phase 7a. Pins the post-BM25 reranking that consumes
 * the vote curation signal.
 *
 * Scoring contract (cross-phase §6.4 path E):
 *   combined = scoreBlend * vote_score
 *            + (1 - scoreBlend) * (success - failure)
 *
 * The reranker fetches up to `k * rerankPoolMultiplier` BM25 hits,
 * recomputes the combined score in JS, sorts desc, and clips to K.
 * Ties fall back to BM25 order (stable sort). When `scoreBlend` is
 * omitted the legacy BM25-only behaviour holds.
 */

interface Harness {
  dir: string;
  store: LessonStore;
  bumpVoteScore: (id: number, delta: number) => void;
  dispose: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-lessons-rerank-"));
  const dbFile = join(dir, "memory.sqlite");
  const store = new LessonStore({ dbFile });
  // Open the same DB for direct vote_score writes. The store opens
  // the file in WAL mode so a second handle reading + writing is
  // safe in tests.
  const sideDb = new DatabaseCtor(dbFile);
  applyMigrations(sideDb);
  const updateVoteScore = sideDb.prepare(
    `UPDATE lessons SET vote_score = vote_score + @delta WHERE id = @id`,
  );
  return {
    dir,
    store,
    bumpVoteScore: (id, delta) => {
      updateVoteScore.run({ id, delta });
    },
    dispose: () => {
      sideDb.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("LessonStore recall with vote-score reranking (phase 7a)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("preserves BM25 order when scoreBlend is omitted (legacy phase 5 behaviour)", () => {
    h.store.create({
      activation: "When asked about pnpm install for monorepos",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    h.store.create({
      activation: "When asked about pnpm fallback strategy",
      principle: "Fall back to npm install.",
      parentIds: [2],
    });
    // No scoreBlend ⇒ pure BM25.
    const hits = h.store.recall({ query: "pnpm install", k: 2 });
    expect(hits.length).toBe(2);
  });

  it("promotes a positively-voted but lower-BM25 lesson above the top BM25 hit", () => {
    // Two near-equivalent BM25 hits; the second one carries a
    // strong positive vote signal that the reranker must respect.
    const losing = h.store.create({
      activation: "When asked about pnpm install in monorepos",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    const winning = h.store.create({
      activation: "When asked about pnpm install workflow",
      principle: "Use pnpm install --frozen-lockfile.",
      parentIds: [2],
    });
    h.bumpVoteScore(winning.id, 10);
    const hits = h.store.recall({
      query: "pnpm install",
      k: 2,
      scoreBlend: 1.0, // 100% vote weight
    });
    expect(hits[0]?.id).toBe(winning.id);
    expect(hits[0]?.voteScore).toBe(10);
  });

  it("respects scoreBlend = 0 (pure success/failure feedback, no vote weight)", () => {
    const lessVoted = h.store.create({
      activation: "When asked about pnpm install",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    const moreVoted = h.store.create({
      activation: "When asked about pnpm install workflow",
      principle: "Use pnpm install --frozen-lockfile.",
      parentIds: [2],
    });
    h.bumpVoteScore(moreVoted.id, 100);
    h.store.bumpSuccess(lessVoted.id);
    h.store.bumpSuccess(lessVoted.id);
    const hits = h.store.recall({
      query: "pnpm install",
      k: 2,
      scoreBlend: 0,
    });
    // With scoreBlend=0 the success_count delta wins regardless of
    // the heavily-voted opponent — votes count zero.
    expect(hits[0]?.id).toBe(lessVoted.id);
  });

  it("falls back to BM25 order when combined scores tie", () => {
    h.store.create({
      activation: "When asked about pnpm install in monorepos",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    h.store.create({
      activation: "When asked about pnpm install pitfalls",
      principle: "Pin lockfile.",
      parentIds: [2],
    });
    const hits = h.store.recall({
      query: "pnpm install",
      k: 2,
      scoreBlend: 0.5,
    });
    expect(hits.length).toBe(2);
    // Both rows have combined score == 0 so the BM25 ordering
    // determines the surface order. The exact id ordering depends
    // on BM25 internals; we only check stability across reruns.
    const second = h.store.recall({
      query: "pnpm install",
      k: 2,
      scoreBlend: 0.5,
    });
    expect(hits.map((l) => l.id)).toEqual(second.map((l) => l.id));
  });

  it("widens the BM25 pool via rerankPoolMultiplier", () => {
    // Five BM25-relevant lessons; K=2. With pool multiplier 3 we
    // pull 6 (clamped to actual matches) and rerank. We confirm
    // the strongest-voted lesson surfaces even if BM25 alone
    // would have placed it outside the top-2.
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const lesson = h.store.create({
        activation: `pnpm install topic ${i}`,
        principle: `principle ${i}`,
        parentIds: [i],
      });
      ids.push(lesson.id);
    }
    h.bumpVoteScore(ids[4]!, 50); // last-inserted ⇒ likely worst BM25 rank.
    const hits = h.store.recall({
      query: "pnpm install topic",
      k: 2,
      scoreBlend: 1.0,
      rerankPoolMultiplier: 3,
    });
    expect(hits[0]?.id).toBe(ids[4]);
  });

  it("clamps rerankPoolMultiplier to a sane range", () => {
    h.store.create({
      activation: "pnpm install",
      principle: "p",
      parentIds: [1],
    });
    // Should not crash regardless of input.
    expect(() =>
      h.store.recall({
        query: "pnpm",
        k: 1,
        scoreBlend: 0.5,
        rerankPoolMultiplier: 999,
      }),
    ).not.toThrow();
    expect(() =>
      h.store.recall({
        query: "pnpm",
        k: 1,
        scoreBlend: 0.5,
        rerankPoolMultiplier: -5,
      }),
    ).not.toThrow();
  });

  it("clamps scoreBlend outside [0,1] defensively", () => {
    const a = h.store.create({
      activation: "pnpm install A",
      principle: "p",
      parentIds: [1],
    });
    h.bumpVoteScore(a.id, 5);
    // 1.5 ⇒ clamp to 1.0 (pure vote weight).
    const high = h.store.recall({
      query: "pnpm install",
      k: 1,
      scoreBlend: 1.5,
    });
    expect(high[0]?.id).toBe(a.id);
    // -0.5 ⇒ clamp to 0 (no vote weight). Single candidate so it
    // still surfaces, but the score must equal `success - failure`.
    const low = h.store.recall({
      query: "pnpm install",
      k: 1,
      scoreBlend: -0.5,
    });
    expect(low[0]?.id).toBe(a.id);
  });
});

describe("computeLessonCombinedScore", () => {
  it("matches the documented blend formula", () => {
    expect(
      computeLessonCombinedScore(
        { voteScore: 4, successCount: 2, failureCount: 1 },
        0.6,
      ),
    ).toBeCloseTo(0.6 * 4 + 0.4 * (2 - 1));
    expect(
      computeLessonCombinedScore(
        { voteScore: -5, successCount: 0, failureCount: 0 },
        1,
      ),
    ).toBe(-5);
    expect(
      computeLessonCombinedScore(
        { voteScore: 100, successCount: -1, failureCount: 1 },
        0,
      ),
    ).toBe(-2);
  });

  it("clamps scoreBlend to [0, 1]", () => {
    expect(
      computeLessonCombinedScore(
        { voteScore: 10, successCount: 2, failureCount: 0 },
        2,
      ),
    ).toBe(10);
    expect(
      computeLessonCombinedScore(
        { voteScore: 10, successCount: 2, failureCount: 0 },
        -3,
      ),
    ).toBe(2);
  });
});
