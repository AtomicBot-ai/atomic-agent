/**
 * E2E-1 — profile recall across silence.
 *
 * Goal: prove that a fact the user states in session 1 reaches the
 * agent's `### profile` block in sessions 2 and 3, and that the
 * agent USES it without re-asking the user.
 *
 * Three sequential sessions against a shared `<stateDir>`. No
 * consolidator tick between them — profile facts are written by
 * reflection at end-of-turn, not by the consolidator, so they should
 * already be present when session 2 starts.
 *
 * The fact is intentionally a specific operational command (not a
 * vague preference) so substring matching on the reply gives a
 * deterministic pass/fail signal.
 */

export interface E2E1ExpectedFact {
  /** Substring that should appear in the agent's reply in S2 / S3. */
  replySubstring: string;
  /** Description of the canonical profile key for the reflection extractor. */
  profileHint: string;
}

export interface E2E1Scenario {
  id: "e2e-1-profile-recall";
  label: string;
  sessions: {
    s1Prompts: readonly string[];
    s2Prompts: readonly string[];
    s3Prompts: readonly string[];
  };
  expected: E2E1ExpectedFact;
}

export const E2E_1_SCENARIO: E2E1Scenario = {
  id: "e2e-1-profile-recall",
  label: "stated deploy command in S1 must be used in S2 and S3 without re-asking",
  sessions: {
    s1Prompts: [
      // One declarative turn — give the agent a concrete, durable fact.
      "Hi. Please remember: my preferred deploy command for this repo is `bin/deploy.sh --bake --env=prod`. Whenever I ask about deploying, use that exact command.",
    ],
    s2Prompts: [
      "How should I deploy the latest commit?",
    ],
    s3Prompts: [
      "Quick deploy please — what's the one-liner?",
    ],
  },
  expected: {
    replySubstring: "bin/deploy.sh",
    profileHint: "deploy-command",
  },
};
