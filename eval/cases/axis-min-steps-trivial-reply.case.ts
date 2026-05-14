import type { EvalCase } from "../harness/case-schema.js";

// AXIS: min_steps.
// Pure-text task — no filesystem, no tools. The planner SHOULD emit a
// single `reply` step. Any tool call here is wasted compute and proof
// that the persona "bias toward action" rule is not biting hard enough.
export const axisMinStepsTrivialReply: EvalCase = {
  id: "axis-min-steps-trivial-reply",
  name: "Reply to a pure-text question without any tool call",
  category: "os",
  capabilityAxis: "min_steps",
  prompt: `Reply with EXACTLY the single word "pong" — nothing else, no quotes, no punctuation. You do not need any tool for this.`,
  expectations: [
    { kind: "reply_contains", pattern: /^pong\s*$/ },
    { kind: "step_count", max: 1 },
  ],
};
