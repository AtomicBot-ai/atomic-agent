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
  sessions: {
    s1Prompts: [
      "Find every row mentioning TARGET_TOKEN across CSV files under ./exports/. Report which files contain it.",
    ],
    s2Prompts: [
      "Same exercise but only under ./exports/2024-Q4/: find rows mentioning TARGET_TOKEN.",
    ],
    s3Prompts: [
      "Quick: which CSVs anywhere under ./exports/ mention TARGET_TOKEN? Just list the file paths.",
    ],
    s4Prompts: [
      "I need every row containing TARGET_TOKEN across all CSVs in ./exports/. Walk me through the approach in one sentence and then run it.",
    ],
  },
  expectedToolHints: ["os.fs.glob", "os.fs.grep"],
  s4ReplyKeywords: ["grep", "glob"],
};
