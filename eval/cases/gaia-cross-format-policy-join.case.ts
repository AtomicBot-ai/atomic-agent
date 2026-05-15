import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: cross-format rule application. The auto-approval rule
 * lives in `policy.pdf` (free prose); the data to filter lives in
 * `requests.xlsx` (20 rows). The agent must read both, parse the
 * conjunctive policy ("amount < 5000 AND category != consulting"),
 * apply it row-by-row, and count.
 *
 * Known answer: 10. (See requests.xlsx in build-fixtures.mjs for
 * the per-row YES/NO annotation.) Boundary at amount=5000 is
 * deliberately included as a NO row (R-017) to test strict-less-than
 * vs. less-than-or-equal interpretation.
 */
export const gaiaCrossFormatPolicyJoin: EvalCase = {
  id: "gaia-cross-format-policy-join",
  name: "Apply PDF auto-approval policy to XLSX rows and count",
  category: "gaia-style",
  capabilityAxis: "instruction_adherence",
  prompt:
    "There are two files in the working directory: `policy.pdf` describes the auto-approval rule for purchase requests, and `requests.xlsx` lists 20 purchase requests. According to the policy, how many requests are auto-approved? Reply with just the integer.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "policy.pdf");
    copyGaiaFixture(workingDir, "requests.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b10\b/ },
    // Negative: common wrong answers from misapplying the rule. 11
    // = counted the boundary row (R-017, 5000) as auto. 12 = also
    // counted one consulting row. 20 = didn't apply filter at all.
    // 0 = applied filter inverted. These shapes should fail.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b11\b)(?!.*\b12\b)(?!.*\b20\b)(?!.*\b0\b)(?!.*\bzero\b).*$/is,
    },
  ],
};
