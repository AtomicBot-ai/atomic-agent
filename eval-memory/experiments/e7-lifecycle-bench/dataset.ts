/**
 * E7 lifecycle-bench dataset.
 *
 * Each scenario is a deterministic fixture for the Phase 6 + 7a
 * lifecycle pipeline:
 *
 *  - Seed a `LessonStore` with N lessons.
 *  - Apply optional age offsets (relative to a frozen `now`).
 *  - Apply optional vote deltas via `VoteStore`.
 *  - Run `consolidator.runOnce()` exactly once.
 *  - Assert deterministic post-conditions on lesson status,
 *    deprecation reason counts, and (where applicable) recall
 *    ordering under `scoreBlend`.
 *
 * No LLM is involved. The dataset is intentionally compact — the
 * goal is to lock the lifecycle contract, not to explore product
 * usefulness (that lives in E2 / E5).
 */

export interface LessonFixture {
  /** Local handle for assertions — converted to the real DB id at runtime. */
  handle: string;
  activation: string;
  principle: string;
  tags?: readonly string[];
  /**
   * Created-at offset relative to the scenario's frozen `now`.
   * Negative values place the lesson in the past. Omit for "just
   * created" lessons.
   */
  createdAtOffsetMs?: number;
  /** Bumped before the consolidator tick. */
  successCount?: number;
  /** Initial `vote_score` before the tick. Applied via direct SQL. */
  voteScore?: number;
  /** Marked surfaced before the tick. */
  recallQuery?: string;
}

export type ExpectedStatus = "active" | "deprecated_by_vote" | "deprecated_by_age" | "deprecated_by_overflow";

export interface LifecycleScenario {
  id: string;
  label: string;
  /** Lessons to seed in `LessonStore`. Order is preserved at insert. */
  lessons: readonly LessonFixture[];
  /** Days the consolidator considers a lesson "aged out" (success_count = 0). */
  deprecationAgeDays: number;
  /** When `true`, recall returns top-K under `scoreBlend`. Drives rerank assertions. */
  rerank?: {
    query: string;
    k: number;
    scoreBlend: number;
    expectedTopOrder: readonly string[];
  };
  /** Expected lesson status after `consolidator.runOnce()`. */
  expected: Record<string, ExpectedStatus>;
}

const DAY = 86_400_000;

export const LIFECYCLE_SCENARIOS: readonly LifecycleScenario[] = [
  {
    id: "vote-driven-eviction",
    label: "downvoted lesson deprecates before the age sweep fires",
    deprecationAgeDays: 30,
    lessons: [
      {
        handle: "doomed",
        activation: "always run npm install instead of pnpm",
        principle: "Never run npm install on this repo because it breaks the lockfile.",
        voteScore: -2,
        createdAtOffsetMs: -1 * DAY, // 1 day old — not age-eligible
      },
      {
        handle: "kept",
        activation: "prefer pnpm install over npm install",
        principle: "This repo uses pnpm; npm install corrupts pnpm-lock.yaml.",
        voteScore: 0,
        createdAtOffsetMs: -1 * DAY,
      },
    ],
    expected: {
      doomed: "deprecated_by_vote",
      kept: "active",
    },
  },
  {
    id: "age-driven-eviction",
    label: "old lesson with no success bumps deprecates by age",
    deprecationAgeDays: 30,
    lessons: [
      {
        handle: "old",
        activation: "remember to bump CHANGELOG.md before release",
        principle: "Release scripts depend on CHANGELOG.md headers; missing it breaks `release-it`.",
        createdAtOffsetMs: -35 * DAY,
        successCount: 0,
      },
      {
        handle: "young",
        activation: "use pnpm install over npm install",
        principle: "This repo uses pnpm; npm install corrupts pnpm-lock.yaml.",
        createdAtOffsetMs: -5 * DAY,
      },
    ],
    expected: {
      old: "deprecated_by_age",
      young: "active",
    },
  },
  {
    id: "success-bumps-save-old-lesson",
    label: "old lesson with positive success_count survives the age sweep",
    deprecationAgeDays: 30,
    lessons: [
      {
        handle: "useful",
        activation: "deploy with `bin/deploy.sh --bake`",
        principle: "The deploy script bakes config into the image; --bake is mandatory.",
        createdAtOffsetMs: -45 * DAY,
        successCount: 3,
      },
      {
        handle: "dormant",
        activation: "remember nothing here",
        principle: "(synthetic neutral)",
        createdAtOffsetMs: -45 * DAY,
        successCount: 0,
      },
    ],
    expected: {
      useful: "active",
      dormant: "deprecated_by_age",
    },
  },
  {
    id: "rerank-promotes-upvoted",
    label: "BM25 ties broken by vote_score under scoreBlend recall",
    deprecationAgeDays: 30,
    lessons: [
      {
        handle: "rare",
        activation: "use BigInt when JSON contains snowflake ids",
        principle: "JSON.parse silently rounds integers above 2^53; pull the raw text and convert to BigInt.",
        voteScore: 0,
        createdAtOffsetMs: -1 * DAY,
        tags: ["json", "bigint"],
      },
      {
        handle: "popular",
        activation: "use BigInt for large int64 ids in JSON payloads",
        principle: "Coerce snowflake ids to BigInt at the ingestion boundary; never compare them after a default JSON.parse.",
        voteScore: 4,
        createdAtOffsetMs: -1 * DAY,
        tags: ["json", "bigint", "snowflake"],
      },
    ],
    rerank: {
      query: "json bigint snowflake",
      k: 2,
      scoreBlend: 0.6,
      expectedTopOrder: ["popular", "rare"],
    },
    expected: {
      rare: "active",
      popular: "active",
    },
  },
  {
    id: "mixed-batch",
    label: "vote, age, and survival signals all coexist in one tick",
    deprecationAgeDays: 30,
    lessons: [
      {
        handle: "downvoted-1",
        activation: "use foo over bar",
        principle: "(synthetic noise)",
        voteScore: -3,
        createdAtOffsetMs: -2 * DAY,
      },
      {
        handle: "downvoted-2",
        activation: "use baz over qux",
        principle: "(synthetic noise)",
        voteScore: -1,
        createdAtOffsetMs: -2 * DAY,
      },
      {
        handle: "aged-out",
        activation: "ancient procedural reminder",
        principle: "(synthetic stale)",
        createdAtOffsetMs: -40 * DAY,
        successCount: 0,
      },
      {
        handle: "upvoted",
        activation: "the deploy procedure is `bin/deploy.sh --bake`",
        principle: "Always pass --bake. Without it the image misses config.",
        voteScore: 5,
        createdAtOffsetMs: -3 * DAY,
        successCount: 2,
      },
      {
        handle: "neutral",
        activation: "lint runs in pre-commit via husky",
        principle: "Husky drives ESLint pre-commit; do not bypass with --no-verify.",
        voteScore: 0,
        createdAtOffsetMs: -3 * DAY,
      },
    ],
    expected: {
      "downvoted-1": "deprecated_by_vote",
      "downvoted-2": "deprecated_by_vote",
      "aged-out": "deprecated_by_age",
      upvoted: "active",
      neutral: "active",
    },
  },
];
