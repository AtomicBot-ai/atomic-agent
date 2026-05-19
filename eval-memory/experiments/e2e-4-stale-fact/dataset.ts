/**
 * E2E-4 — stale fact correction (bi-temporal supersession).
 *
 * Goal: prove that when the user states a new value for a fact they
 * previously stated, the agent's reflection updates the profile to
 * the NEW value and subsequent sessions use only the new value.
 *
 * Flow:
 *   S1 — establish the original fact ("timezone is Europe/Moscow").
 *   S2 — user explicitly corrects ("scratch that, it's now
 *        America/New_York; use that from now on").
 *   S3 — fresh session asks a question whose natural answer is
 *        anchored on the timezone. The agent should reference the
 *        NEW fact and never mention the stale one.
 *
 * Asserts:
 *   - profile_facts table contains the new value (string match)
 *     after S2's reflection,
 *   - profile_facts table does NOT contain the stale value as the
 *     active row for the same key (i.e. SET overwrote — checked by
 *     scanning row values),
 *   - S3 reply mentions the new value (`new york` / `est` / `edt`)
 *     and does NOT mention the stale one (`moscow` / `msk`).
 */

export interface E2E4Scenario {
  id: "e2e-4-stale-fact";
  label: string;
  sessions: {
    s1Prompts: readonly string[];
    s2Prompts: readonly string[];
    s3Prompts: readonly string[];
  };
  /** Substrings expected in the new profile value (any one is enough). */
  newValueSubstrings: readonly string[];
  /** Substrings that must NOT appear in either profile values or S3 reply. */
  staleSubstrings: readonly string[];
}

export const E2E_4_SCENARIO: E2E4Scenario = {
  id: "e2e-4-stale-fact",
  label:
    "agent learns timezone (S1), is corrected (S2), and uses ONLY the new value in S3",
  sessions: {
    s1Prompts: [
      "Quick note: my work timezone is Europe/Moscow. Please remember this for any future scheduling help.",
    ],
    s2Prompts: [
      "Scratch the previous timezone — I moved. From now on my work timezone is America/New_York. Update your memory; only use the new one for scheduling.",
    ],
    s3Prompts: [
      "What is a reasonable time for a one-hour sync I could schedule next Tuesday morning, in my local timezone?",
    ],
  },
  newValueSubstrings: ["new_york", "new york", "est", "edt", "et "],
  staleSubstrings: ["moscow", "msk"],
};
