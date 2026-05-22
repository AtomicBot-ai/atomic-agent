/**
 * E12 — all-three-on combined smoke test.
 *
 * One scenario: a single 18-turn session with rewriter, segmentation
 * and typed-notes flags all flipped on. The turn mix is:
 *
 *   - factual statements that should provoke typed NOTE writes,
 *   - short referential follow-ups that should fire the rewriter,
 *   - filler prompts to spread reflection cadence fires.
 *
 * The scorecard §6 invariants the runner asserts are:
 *
 *   - at least N reflection.fired events (cadence-gated, so
 *     fewer than the legacy off path),
 *   - the rewriter fired on at least one referential follow-up
 *     (`agent.memory.retrieve.rewriter{outcome=ok}` increments
 *     via the stderr `rewriter.ok` debug line),
 *   - at least one `type:*` tag appears in `memories.tags`,
 *   - the agent never crashed mid-run (exit code 0).
 *
 * The 18-turn shape is a compromise between scorecard §6's
 * 30-turn idea and a wall-clock budget that keeps the suite
 * under ~30 minutes on a 9B model.
 */

export interface E12Scenario {
  id: string;
  label: string;
  prompts: readonly string[];
  maxSteps: number;
  timeoutMs: number;
}

const COMBINED_PROMPTS: readonly string[] = [
  "Remember: I'm planning a multi-week trip to Lisbon in October.",
  "I always book direct flights when the price difference is under 20%.",
  "Yesterday I went hiking with Bob in the Sintra hills for the first time.",
  "and what about there?",
  "I prefer staying in apartment rentals over hotels for stays over 5 nights.",
  "ok",
  "Note: my passport expires in March 2027.",
  "And that one?",
  "Reply: ok",
  "I always carry a power adapter for European outlets when travelling.",
  "Reply: noted",
  "What was the city again?",
  "Reply: fine",
  "Reply: sure",
  "Reply: alright",
  "Reply: ok",
  "Reply: yes",
  "Reply: noted",
];

export const E12_SCENARIO: E12Scenario = {
  id: "combined-smoke",
  label: "rewriter + segmentation + typed-notes on, 18-turn session",
  prompts: COMBINED_PROMPTS,
  maxSteps: 8,
  timeoutMs: 25 * 60_000,
};
