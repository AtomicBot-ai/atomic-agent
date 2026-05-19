/**
 * E2E-3 — procedure-follow on similar task (Phase 7b).
 *
 * Goal: prove that a recurring tool-call chain executed in early
 * sessions is captured as a `Procedure` by the consolidator (with
 * `withProcedure=true`), and that the resulting procedure is
 * (a) persisted with the expected activation / tool-hint shape, and
 * (b) surfaced enough to influence a similar request in a later
 * session.
 *
 * Sessions S1..S3 each ask the agent to scan a small CSV directory
 * for a substring — the workingDir is seeded with throwaway CSV
 * files so the agent's natural answer is to fan out
 * `os.fs.glob` + `os.fs.grep`. After enough episodes the
 * consolidator detects the cluster and the combined distill call
 * produces both a lesson and a procedure.
 *
 * Asserts:
 *   - procedures table count >= 1 after the consolidator step,
 *   - the procedure carries at least one step with toolHint matching
 *     `os.fs.glob` or `os.fs.grep`,
 *   - S4 final reply mentions either tool name (loose proxy for
 *     "the agent is leaning on the procedure recipe").
 */

export interface E2E3Scenario {
  id: "e2e-3-procedure-follow";
  label: string;
  /**
   * Files to seed into the workingDir before any session runs. The
   * agent reads these via `os.fs.glob` / `os.fs.grep` — without
   * them the answers degrade to "I'd run X" with no actual tool
   * invocations, which defeats the whole exercise.
   */
  csvFixtures: ReadonlyArray<{ path: string; content: string }>;
  sessions: {
    s1Prompts: readonly string[];
    s2Prompts: readonly string[];
    s3Prompts: readonly string[];
    s4Prompts: readonly string[];
  };
  /** Tool hints we expect to see on at least one procedure step. */
  expectedToolHints: readonly string[];
  /** Tool names that S4 reply is expected to mention (loose proxy). */
  s4ReplyKeywords: readonly string[];
}

const SAMPLE_CSV_A = [
  "id,name,note",
  "1,acme,first",
  "2,acme,with TARGET_TOKEN",
  "3,beta,unrelated",
].join("\n");
const SAMPLE_CSV_B = [
  "id,name,note",
  "10,gamma,nothing here",
  "11,delta,TARGET_TOKEN match",
  "12,epsilon,more text",
].join("\n");
const SAMPLE_CSV_C = [
  "id,name,note",
  "100,zeta,empty",
  "101,eta,empty",
  "102,theta,empty",
].join("\n");

export const E2E_3_SCENARIO: E2E3Scenario = {
  id: "e2e-3-procedure-follow",
  label:
    "agent learns to scan CSVs via glob+grep across S1..S3; procedure emitted and re-applied in S4",
  csvFixtures: [
    { path: "exports/2024-Q3/customers.csv", content: SAMPLE_CSV_A },
    { path: "exports/2024-Q4/customers.csv", content: SAMPLE_CSV_B },
    { path: "exports/legacy/customers.csv", content: SAMPLE_CSV_C },
  ],
  // Drift-resistant prompts. S1..S3 each ask the agent to record one
  // explicit `memory.notes.store` describing the same two-step CSV
  // scan recipe (os.fs.glob → os.fs.grep). We deliberately do NOT
  // make the agent actually run the recipe in S1..S3: under the
  // current Gemma-4 sampling, mixing "execute" + "remember" in one
  // single-turn session is unreliable — half the runs the model
  // never reaches the `memory.notes.store` call before the reply,
  // which leaves the consolidator with 0–1 memories and no cluster
  // (E2E-3 v1 spent 6+ minutes on a hung S3 trying to glob/grep
  // before giving up). Here S1..S3 are pure "log the recipe", and
  // S4 is the only session that actually exercises the recipe — it
  // is the one whose reply we score, and it has the persisted
  // Lesson + Procedure to lean on.
  sessions: {
    // The bodies below are intentionally step-shaped ("Step 1: ...
    // Step 2: ...") so the consolidator's distill prompt sees a
    // procedural cluster and emits both a Lesson AND a Procedure.
    // Free-form "recipe for X" descriptions tend to distill into a
    // Lesson only (the procedure half stays empty) — the combined
    // grammar permits that branch on conceptual clusters.
    s1Prompts: [
      "Call `memory.notes.store` exactly once with content='How to scan CSVs for a token — Step 1: call os.fs.glob to enumerate every matching csv path under the target directory. Step 2: call os.fs.grep over each path with the target token.' and tags=['csv','scan','glob','grep','procedure']. After storing, reply in one short sentence acknowledging the note. Do not call any other tools.",
    ],
    s2Prompts: [
      "Call `memory.notes.store` exactly once with content='CSV token search — Step 1: os.fs.glob the directory for *.csv. Step 2: os.fs.grep each matched file for the requested token. Always perform both steps in this exact order.' and tags=['csv','scan','glob','grep','procedure']. Reply in one short sentence. No other tools.",
    ],
    s3Prompts: [
      "Call `memory.notes.store` exactly once with content='Two-step CSV scan procedure — Step 1: os.fs.glob the directory pattern (e.g. exports/**/*.csv). Step 2: os.fs.grep the resulting paths for the token. Output the paths that matched.' and tags=['csv','scan','glob','grep','procedure']. Reply in one short sentence. No other tools.",
    ],
    s4Prompts: [
      "I need every row containing TARGET_TOKEN across all CSVs in ./exports/. Apply our team's standard recipe — walk me through the approach in one sentence and then run it. The csv fixtures already exist on disk.",
    ],
  },
  expectedToolHints: ["os.fs.glob", "os.fs.grep"],
  s4ReplyKeywords: ["grep", "glob"],
};
