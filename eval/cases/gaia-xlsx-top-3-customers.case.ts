import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: groupby + sort + ordered output. The agent must sum
 * each customer's Amount across all rows in `transactions.xlsx`,
 * rank the totals, and return the top three customer names in
 * **descending** order.
 *
 * Per-customer totals (see transactions.xlsx in build-fixtures.mjs):
 *   Cyberdyne          12000
 *   Initech            10300
 *   Globex              5000
 *   Umbrella            3000
 *   Stark Industries    2200
 *   Hooli               2100
 *   Wayne Enterprises   1500
 *
 * Known answer (top-3 desc): Cyberdyne, Initech, Globex.
 *
 * Strict on ORDER: a reply that names the right three but in
 * ascending order, or interleaved with extra names, fails. The
 * regex anchors the three names with optional whitespace/comma
 * between them and accepts no other name between Cyberdyne and
 * Globex.
 */
export const gaiaXlsxTop3Customers: EvalCase = {
  id: "gaia-xlsx-top-3-customers",
  name: "Top-3 customers by total amount (ordered, comma-separated)",
  category: "gaia-style",
  capabilityAxis: "instruction_adherence",
  prompt:
    "Open `transactions.xlsx` in the working directory. Sum each Customer's Amount across all rows, then list the top 3 customers in descending order of total. Reply with just the three customer names, comma-separated, in descending order (e.g. `A, B, C`). No totals, no explanation.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "transactions.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    // Positive: the three names appear in the correct desc order
    // (Cyberdyne -> Initech -> Globex), tolerant of surrounding
    // whitespace and comma styling.
    {
      kind: "reply_contains",
      pattern: /\bCyberdyne\b[\s,]+\bInitech\b[\s,]+\bGlobex\b/i,
    },
    // Negative: lower-ranked customers (Umbrella, Stark, Hooli,
    // Wayne) MUST NOT appear in the reply. Catches "I'll list
    // everyone" dumps.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\bUmbrella\b)(?!.*\bStark\b)(?!.*\bHooli\b)(?!.*\bWayne\b).*$/is,
    },
  ],
};
