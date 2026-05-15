import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style HARD: multi-hop with vague bridging keyword.
 *
 * Same fixtures as `gaia-multihop-vendor-budget` (vendors.pdf +
 * budgets.xlsx), but the prompt asks about the "award-winning
 * vendor" instead of "vendor of the year". The agent has to map
 * "award-winning" → "vendor of the year" semantically while
 * reading the PDF; a literal-substring search won't bridge.
 *
 * Failure modes:
 *   - looking for the literal phrase "award-winning" in the PDF
 *     and giving up when it's absent;
 *   - guessing the answer based on the highest March number
 *     (12000) without reading the PDF — accidentally correct on
 *     this fixture but pure luck;
 *   - confusing "award-winning" with "top-spending" (would land
 *     on Globex anyway but via wrong reasoning).
 *
 * Known answer: 12000 (Globex March spend).
 */
export const gaiaHardMultihopVague: EvalCase = {
  id: "gaia-hard-multihop-vague",
  name: "Multi-hop with vague bridging keyword (award-winning vs vendor of the year)",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There's a vendor performance review and a budget spreadsheet in the working directory. What was the award-winning vendor's spend in March? Reply with just the integer (no currency, no commas).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "vendors.pdf");
    copyGaiaFixture(workingDir, "budgets.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b12000\b/ },
    // Negative: reject dump-everyone replies. Acme Mar 6000,
    // Initech Mar 3300, Umbrella Mar 4900, Stark Mar 7500.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b6000\b)(?!.*\b3300\b)(?!.*\b4900\b)(?!.*\b7500\b).*$/is,
    },
  ],
};
