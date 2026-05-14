import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: self_termination.
// Single-fact lookup. The agent should know it has the answer after
// the first read and IMMEDIATELY emit `reply`. Failure mode: needless
// further exploration ("let me also check ...", "let me list the dir
// just to be sure"). step_count == 2 is the unambiguous signal of
// concise termination.
export const axisSelfTermAfterFind: EvalCase = {
  id: "axis-self-term-after-find",
  name: "Terminate immediately after finding the answer",
  category: "os",
  capabilityAxis: "self_termination",
  prompt: `What is the value of the "version" field in package.json? Reply with just the version string.`,
  setup: ({ workingDir }) => {
    writeFileSync(
      join(workingDir, "package.json"),
      JSON.stringify({ name: "eval-pkg", version: "9.4.2-axis", scripts: {} }, null, 2),
      "utf8",
    );
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "reply_contains", pattern: /9\.4\.2-axis/ },
    { kind: "step_count", max: 2 },
  ],
};
