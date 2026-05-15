import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: conditional categorical answer based on aggregated
 * arithmetic. The agent must sum all four quarters from
 * `quarterly-report.pdf` (6.2 + 7.1 + 8.4 + 9.0 = 30.7), compare
 * against a threshold (30.0), and return a fixed-vocabulary token
 * (EXCEED / BELOW) instead of the number itself.
 *
 * Known answer: EXCEED (30.7 >= 30). The strict reply shape filters
 * out chatty replies like "30.7 — EXCEED" if they also contain
 * BELOW.
 */
export const gaiaConditionalRevenue: EvalCase = {
  id: "gaia-conditional-revenue",
  name: "Conditional answer from summed quarterly revenue (EXCEED/BELOW)",
  category: "gaia-style",
  capabilityAxis: "instruction_adherence",
  prompt:
    "There is a file `quarterly-report.pdf` in the working directory. Sum the four quarterly revenue figures for 2024. If the total is at least 30 (in millions USD), reply with exactly the word `EXCEED`. Otherwise reply with exactly the word `BELOW`. Reply with just the single word — no number, no explanation.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "quarterly-report.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\bEXCEED\b/ },
    // Negative: the wrong-branch token must not appear (handles the
    // "could be EXCEED or BELOW depending on..." hedge).
    {
      kind: "reply_contains",
      pattern: /^(?!.*\bBELOW\b).*$/is,
    },
  ],
};
