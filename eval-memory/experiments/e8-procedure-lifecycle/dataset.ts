/**
 * E8 procedure-lifecycle-bench dataset.
 *
 * Mirror of E7 but for `ProcedureStore` + the phase-7b cascade /
 * use-count semantics that don't exist on `Lesson`. Every scenario
 * is a deterministic fixture:
 *
 *  - Seed a `ProcedureStore` (and optionally a `LessonStore` for
 *    the cascade scenario) with N procedures.
 *  - Apply optional age offsets relative to a frozen `now`.
 *  - Apply optional vote deltas via direct SQL.
 *  - Run `consolidator.runOnce()` exactly once.
 *  - Assert deterministic post-conditions on procedure status,
 *    the per-reason tally tuple
 *    `(byVote, byAge, byOverflow, byCascade)`, and (when set)
 *    `scoreBlend` recall ordering.
 *
 * No LLM is involved. This locks the lifecycle contract for path P
 * (phase 7b) end-to-end — including the cross-store cascade that
 * is the load-bearing difference from lessons.
 */

export interface ProcedureFixture {
  /** Local handle for assertions — converted to the real DB id at runtime. */
  handle: string;
  activation: string;
  /** 2..8 steps; each has `description` and optional `toolHint`. */
  steps: ReadonlyArray<{ description: string; toolHint?: string | null }>;
  tags?: readonly string[];
  /**
   * Created-at offset relative to the scenario's frozen `now`.
   * Negative values place the procedure in the past.
   */
  createdAtOffsetMs?: number;
  /** Bumped before the consolidator tick — saves age-eligible procs. */
  successCount?: number;
  /** Bumped before the consolidator tick — also saves age-eligible procs. */
  useCount?: number;
  /** Initial `vote_score` applied via direct SQL. */
  voteScore?: number;
  /** Handles of lesson fixtures this procedure cascades from. */
  parentLessonHandles?: readonly string[];
}

export interface LessonFixtureLite {
  /** Local handle. */
  handle: string;
  activation: string;
  principle: string;
  voteScore?: number;
  /**
   * When true, this lesson will be in the vote-driven sweep set on
   * the consolidator tick (drives the procedure cascade test).
   */
  forceDeprecateByVote?: boolean;
}

export type ExpectedProcedureStatus =
  | "active"
  | "deprecated_by_vote"
  | "deprecated_by_age"
  | "deprecated_by_overflow"
  | "deprecated_by_cascade";

export interface ProcedureLifecycleScenario {
  id: string;
  label: string;
  /** Lessons seeded into `LessonStore`. Only the cascade scenario uses these. */
  lessons?: readonly LessonFixtureLite[];
  /** Procedures seeded into `ProcedureStore`. */
  procedures: readonly ProcedureFixture[];
  /** Days the consolidator considers a procedure "aged out". */
  procedureDeprecationAgeDays?: number;
  /** Days for lesson age sweep — only relevant for cascade tests. */
  lessonDeprecationAgeDays?: number;
  /** Override `maxEntries` on the procedure store. Default 500. */
  procedureMaxEntries?: number;
  /** When set, recall is exercised after the tick with `scoreBlend`. */
  rerank?: {
    query: string;
    k: number;
    scoreBlend: number;
    expectedTopOrder: readonly string[];
  };
  expected: Record<string, ExpectedProcedureStatus>;
}

const DAY = 86_400_000;

export const PROCEDURE_LIFECYCLE_SCENARIOS: readonly ProcedureLifecycleScenario[] = [
  {
    id: "vote-driven-eviction",
    label: "downvoted procedure deprecates before the age sweep fires",
    procedureDeprecationAgeDays: 30,
    procedures: [
      {
        handle: "doomed",
        activation: "always run pnpm via npx",
        steps: [
          { description: "Open terminal", toolHint: null },
          { description: "Type `npx pnpm install`", toolHint: "os.shell.run" },
        ],
        voteScore: -2,
        createdAtOffsetMs: -1 * DAY,
      },
      {
        handle: "kept",
        activation: "scan CSVs for a substring",
        steps: [
          { description: "Glob `*.csv`", toolHint: "os.fs.glob" },
          { description: "Grep for the query", toolHint: "os.fs.grep" },
        ],
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
    label: "old procedure with no success/use bumps deprecates by age",
    procedureDeprecationAgeDays: 30,
    procedures: [
      {
        handle: "old",
        activation: "format JSON before committing",
        steps: [
          { description: "Run prettier --write", toolHint: "os.shell.run" },
          { description: "git add", toolHint: "os.shell.run" },
        ],
        createdAtOffsetMs: -45 * DAY,
        successCount: 0,
        useCount: 0,
      },
      {
        handle: "young",
        activation: "scan CSVs for a substring",
        steps: [
          { description: "Glob `*.csv`", toolHint: "os.fs.glob" },
          { description: "Grep for the query", toolHint: "os.fs.grep" },
        ],
        createdAtOffsetMs: -5 * DAY,
      },
    ],
    expected: {
      old: "deprecated_by_age",
      young: "active",
    },
  },
  {
    id: "use-count-saves-old-procedure",
    label: "old procedure with positive use_count survives the age sweep",
    procedureDeprecationAgeDays: 30,
    procedures: [
      {
        handle: "useful",
        activation: "deploy with bin/deploy.sh --bake",
        steps: [
          { description: "Run bin/deploy.sh --env=prod --bake", toolHint: "os.shell.run" },
          { description: "Verify health endpoint", toolHint: "os.http.request" },
        ],
        createdAtOffsetMs: -45 * DAY,
        useCount: 2,
      },
      {
        handle: "successful",
        activation: "format JSON before committing",
        steps: [
          { description: "Run prettier --write", toolHint: "os.shell.run" },
          { description: "git add", toolHint: "os.shell.run" },
        ],
        createdAtOffsetMs: -50 * DAY,
        successCount: 3,
      },
      {
        handle: "dormant",
        activation: "synthetic neutral procedure",
        steps: [
          { description: "Do nothing", toolHint: null },
          { description: "Do nothing again", toolHint: null },
        ],
        createdAtOffsetMs: -45 * DAY,
      },
    ],
    expected: {
      useful: "active",
      successful: "active",
      dormant: "deprecated_by_age",
    },
  },
  {
    id: "rerank-promotes-upvoted",
    label: "BM25 ties broken by vote_score under scoreBlend recall",
    procedureDeprecationAgeDays: 30,
    procedures: [
      {
        handle: "rare",
        activation: "scan CSVs for snowflake ids using BigInt",
        steps: [
          { description: "Glob `*.csv`", toolHint: "os.fs.glob" },
          { description: "Grep for the bigint pattern", toolHint: "os.fs.grep" },
        ],
        voteScore: 0,
        createdAtOffsetMs: -1 * DAY,
        tags: ["csv", "bigint"],
      },
      {
        handle: "popular",
        activation: "scan CSVs for snowflake int64 ids",
        steps: [
          { description: "Glob `*.csv` in the cwd", toolHint: "os.fs.glob" },
          { description: "Grep for snowflake pattern", toolHint: "os.fs.grep" },
          { description: "Coerce matches to BigInt", toolHint: null },
        ],
        voteScore: 4,
        createdAtOffsetMs: -1 * DAY,
        tags: ["csv", "bigint", "snowflake"],
      },
    ],
    rerank: {
      query: "csv bigint snowflake",
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
    id: "cascade-from-lesson",
    label: "lesson deprecation cascades to procedures listing it as parent",
    procedureDeprecationAgeDays: 30,
    lessons: [
      {
        handle: "doomed-lesson",
        activation: "always run npm install instead of pnpm",
        principle: "Synthetic noise lesson — will be downvoted.",
        voteScore: -3,
        forceDeprecateByVote: true,
      },
      {
        handle: "alive-lesson",
        activation: "scan CSVs for snowflake ids using BigInt",
        principle: "Use BigInt at the ingestion boundary for snowflake ids.",
      },
    ],
    procedures: [
      {
        handle: "child-of-doomed",
        activation: "run npm install in subfolder",
        steps: [
          { description: "cd subfolder", toolHint: "os.shell.run" },
          { description: "npm install", toolHint: "os.shell.run" },
        ],
        createdAtOffsetMs: -1 * DAY,
        parentLessonHandles: ["doomed-lesson"],
      },
      {
        handle: "child-of-alive",
        activation: "scan CSVs with BigInt",
        steps: [
          { description: "Glob csv", toolHint: "os.fs.glob" },
          { description: "Grep snowflake", toolHint: "os.fs.grep" },
        ],
        createdAtOffsetMs: -1 * DAY,
        parentLessonHandles: ["alive-lesson"],
      },
      {
        handle: "orphan",
        activation: "format JSON",
        steps: [
          { description: "prettier --write", toolHint: "os.shell.run" },
          { description: "git add", toolHint: "os.shell.run" },
        ],
        createdAtOffsetMs: -1 * DAY,
      },
    ],
    expected: {
      "child-of-doomed": "deprecated_by_cascade",
      "child-of-alive": "active",
      orphan: "active",
    },
  },
  {
    id: "fifo-overflow",
    label: "active count exceeds maxEntries → oldest by (vote, updated_at) demoted",
    procedureDeprecationAgeDays: 0, // disable age sweep so we isolate overflow
    procedureMaxEntries: 3,
    procedures: [
      {
        handle: "oldest-low",
        activation: "oldest neutral procedure",
        steps: [
          { description: "step 1", toolHint: null },
          { description: "step 2", toolHint: null },
        ],
        // voteScore intentionally 0 — overflow sweep is FIFO-by-vote
        // then updated_at; if we set this negative, the vote sweep
        // (which runs first) would deprecate it before overflow ever
        // looks at it, and the scenario stops testing overflow.
        voteScore: 0,
        createdAtOffsetMs: -5 * DAY,
      },
      {
        handle: "middle",
        activation: "middle, neutral",
        steps: [
          { description: "step 1", toolHint: null },
          { description: "step 2", toolHint: null },
        ],
        voteScore: 0,
        createdAtOffsetMs: -3 * DAY,
      },
      {
        handle: "newer-high",
        activation: "newer, high vote",
        steps: [
          { description: "step 1", toolHint: null },
          { description: "step 2", toolHint: null },
        ],
        voteScore: 3,
        createdAtOffsetMs: -2 * DAY,
      },
      {
        handle: "newest",
        activation: "newest, neutral",
        steps: [
          { description: "step 1", toolHint: null },
          { description: "step 2", toolHint: null },
        ],
        voteScore: 0,
        createdAtOffsetMs: -1 * DAY,
      },
    ],
    expected: {
      "oldest-low": "deprecated_by_overflow",
      middle: "active",
      "newer-high": "active",
      newest: "active",
    },
  },
];
