import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: min_steps.
// Trivial single-fact lookup. The planner SHOULD emit one tool-call
// step (os.fs.read) followed by one terminal reply — total 2 steps.
// Anything more means redundant exploration (extra list / glob / read
// of unrelated files) and shows the planner is over-thinking.
export const axisMinStepsSingleRead: EvalCase = {
  id: "axis-min-steps-single-read",
  name: "Answer a one-fact question in exactly 2 steps",
  category: "os",
  capabilityAxis: "min_steps",
  prompt: `What is the value of the "port" line in config.yml? Reply with just the integer.`,
  setup: ({ workingDir }) => {
    writeFileSync(
      join(workingDir, "config.yml"),
      "host: localhost\nport: 8421\nretries: 3\n",
      "utf8",
    );
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b8421\b/ },
    { kind: "step_count", max: 2 },
  ],
};
