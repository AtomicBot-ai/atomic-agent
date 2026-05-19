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

export interface E2E5SeedMemory {
  content: string;
  tags?: readonly string[];
}

export interface E2E5Scenario {
  id: "e2e-5-vote-cleansing";
  label: string;
  /**
   * Fixture memories written via `MemoryStore.store()` before the
   * session runs. The vote pipeline can only react to rows that
   * survive into `### recalled` — seeding deterministically removes
   * memory-creation variance from the assertion.
   */
  seedMemories: readonly E2E5SeedMemory[];
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
  /**
   * Memories seeded directly into MemoryStore via the driver's
   * `seed_memories` step before the session starts. The subject of
   * E2E-5 is the **vote pipeline**, not memory creation; the two
   * fixture rows below are the equivalent of `linkSweepExample` in
   * E2E-3 — deterministic setup so the assertion can focus on the
   * downstream pipeline. See multi-session-driver `SeededMemory`.
   */
  seedMemories: [
    {
      content:
        "CI fails on macOS runners with 'cannot connect to docker daemon'. Fix: restart Docker Desktop and re-run the workflow.",
      tags: ["ci", "docker", "macos", "recipe"],
    },
    {
      content:
        "User is currently reading sci-fi novels by Le Guin, mostly The Dispossessed.",
      tags: ["hobby", "books", "sci-fi"],
    },
  ],
  prompts: [
    // 1. Re-surface the USEFUL memory by direct recall so it lands in
    // `### recalled` / `### memory-index` (vote-runner allowlist).
    "Call memory.notes.recall with query=\"docker daemon CI macOS fix\" and k=3. Then summarise the fix in one sentence.",
    // 2. Explicit positive signal — vote-runner observes this reply +
    // the freshly-surfaced CI memory. Plain text, no tool call.
    "Perfect, that fix worked again. That note about restarting Docker Desktop was exactly what I needed — keep it, it's gold.",
    // 3. Re-surface the NOISE memory by direct recall.
    "Call memory.notes.recall with query=\"reading hobby books sci-fi Le Guin\" and k=3. Then tell me what I mentioned.",
    // 4. Explicit negative signal — vote-runner observes the surfaced
    // noise memory and the user's verdict. We do NOT want the agent
    // to physically delete the row via `memory.notes.forget`: the
    // vote pipeline is the system-of-record for "this is low value,
    // demote it in future recall" and the assertion runs against
    // `memories.vote_score`. Empirically the model interprets
    // "disregard" as a forget directive on Gemma-4, so the prompt
    // explicitly forbids forget here. Plain-text acknowledgement is
    // enough — the vote-runner observes recall + reply on its own.
    "That reading-habits note is low-priority noise for an engineering assistant. Please mark it as not useful for your future replies, but DO NOT call memory.notes.forget — keep the row, just stop bringing it up. Reply with a one-sentence acknowledgement, no tool calls.",
  ],
  expectPositiveVotes: true,
  expectNegativeVotes: true,
};
