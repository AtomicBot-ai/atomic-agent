/**
 * E10 — sliding-window reflection segmentation (v2.5 Phase B).
 *
 * The dataset is intentionally short and arithmetic-free: each
 * scenario asserts a property of the **cadence gate** —
 *   - segmentation on  → fires every Nth user turn (default N=3)
 *   - segmentation off → fires on every user-turn reply
 *
 * The final-flush invariant (`reason === "finish"` always fires)
 * is pinned by `src/agent/agent-loop-segmentation.test.ts` and not
 * re-tested here — `atomic-agent run` exits on stdin EOF, not via
 * the agent emitting `finish`, so the CLI surface cannot exercise
 * that branch end-to-end.
 */

export interface E10Scenario {
  id: string;
  label: string;
  segmentationEnabled: boolean;
  triggerEveryTurns?: number;
  windowTurns?: number;
  /** Short, low-tool-call prompts so 6 turns finish under timeout. */
  prompts: readonly string[];
  /**
   * Expected number of `reflection.fired` events observed in the
   * agent's stderr (debug log line). Inclusive range — the model
   * can miss a fire on a flaky session and a deferred segment is
   * still legitimate.
   */
  expectedFiresMin: number;
  expectedFiresMax: number;
  maxSteps: number;
  timeoutMs: number;
}

const SHORT_PROMPTS: readonly string[] = [
  "Reply with the single word: ok",
  "Reply with the single word: yes",
  "Reply with the single word: sure",
  "Reply with the single word: noted",
  "Reply with the single word: alright",
  "Reply with the single word: fine",
];

export const E10_SCENARIOS: readonly E10Scenario[] = [
  {
    id: "segmentation-on",
    label: "segmentation on (triggerEveryTurns=3) — fires at turn 3 and turn 6",
    segmentationEnabled: true,
    triggerEveryTurns: 3,
    windowTurns: 5,
    prompts: SHORT_PROMPTS,
    // 6 turns / 3 = 2 cadence-driven fires. Allow some slack —
    // the agent may legitimately emit extra `finish`-like flushes
    // in edge cases that we do not enumerate here.
    expectedFiresMin: 1,
    expectedFiresMax: 3,
    maxSteps: 6,
    timeoutMs: 12 * 60_000,
  },
  {
    id: "segmentation-off",
    label: "segmentation off (legacy) — fires every reply turn",
    segmentationEnabled: false,
    prompts: SHORT_PROMPTS,
    // Legacy path: fire on every reply turn that arrived with a
    // user message. 6 turns ≈ 6 fires; tolerate 4..7 for noise.
    expectedFiresMin: 4,
    expectedFiresMax: 7,
    maxSteps: 6,
    timeoutMs: 12 * 60_000,
  },
];
