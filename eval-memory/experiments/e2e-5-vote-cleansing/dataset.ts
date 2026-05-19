/**
 * E2E-5 — vote-driven noise cleansing.
 *
 * Goal: prove that the end-to-end vote pipeline actually mutates
 * `vote_score` on memory rows when the user supplies explicit signal
 * about whether a surfaced item helped or was noise.
 *
 * This is the trickiest scenario because vote_score only moves for
 * items the vote-runner saw under `### recalled` / `### memory-index`
 * during a turn. To force that surfacing, the turn flow alternates:
 *   - declarative turn: state a fact (memory written by reflection),
 *   - follow-up turn: ask a question that should re-surface that
 *     memory (so it lands in the vote-runner's allowlist),
 *   - signal turn: user explicitly tells the agent how the previous
 *     reply landed ("perfect, that helped" vs "that was off-topic").
 *
 * We run two parallel topic strands inside ONE session — a useful
 * one (CI / Docker troubleshooting) and a noise one (reading habits).
 * After the session we read `memories.vote_score` directly and
 * assert that at least one row has score > 0 and at least one has
 * score < 0.
 *
 * No consolidator tick is required for the assertion to land, but
 * we include one anyway so reports show whether the downvoted
 * memories are also picked up by the vote sweep.
 */

export interface E2E5Scenario {
  id: "e2e-5-vote-cleansing";
  label: string;
  /** Single-session, multi-turn flow. Each entry is one user prompt. */
  prompts: readonly string[];
  /** When true the spec is satisfied if ANY vote_score > 0. */
  expectPositiveVotes: boolean;
  /** When true the spec is satisfied if ANY vote_score < 0. */
  expectNegativeVotes: boolean;
}

export const E2E_5_SCENARIO: E2E5Scenario = {
  id: "e2e-5-vote-cleansing",
  label:
    "explicit user signal on useful/noise turns moves vote_score in both directions",
  prompts: [
    // 1. Seed the USEFUL memory.
    "FYI for future reference: when our CI fails on macOS runners with the error 'cannot connect to docker daemon', the fix is to restart Docker Desktop and re-run. Please remember this for the next time I ask about CI.",
    // 2. Seed the NOISE memory (declarative but off-topic).
    "Side note that has nothing to do with engineering: I've been getting back into sci-fi novels this year, mostly Le Guin.",
    // 3. Ask a follow-up that should re-surface the USEFUL memory.
    "Our CI just failed on the macOS runner with the docker daemon error again. What was the fix you remembered?",
    // 4. Explicit positive signal — the vote-runner observes this turn's reply + the freshly-surfaced memory.
    "Perfect, that worked. Exactly the trick I needed.",
    // 5. Ask a follow-up that should re-surface the NOISE memory.
    "What sort of books did I mention being interested in lately?",
    // 6. Explicit negative signal — vote-runner observes the surfaced noise memory and the reply that drifted off-task.
    "Actually let's just disregard that reading-habits stuff entirely. It's noise relative to the work I want help with — please mark it as not useful.",
  ],
  expectPositiveVotes: true,
  expectNegativeVotes: true,
};
