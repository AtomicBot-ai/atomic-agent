import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: filter + aggregate on a small XLSX (the canonical
 * GAIA Level-2 pattern). The fixture has 12 transaction rows
 * spanning 3 categories and 3 months. Only the 3 January rows
 * with category=subscription contribute to the answer; the other
 * 9 rows are decoys (different month or different category) that
 * MUST be excluded.
 *
 * Known answer: 4500 (3 × 1500 USD).
 */
export const gaiaXlsxConditionalSum: EvalCase = {
  id: "gaia-xlsx-conditional-sum",
  name: "Sum January 2024 subscription revenue from transactions.xlsx",
  category: "gaia-style",
  prompt:
    "Open `transactions.xlsx` in the working directory. Compute the total Amount across all rows where Category is exactly `subscription` AND the Date is in January 2024. Reply with just the integer total (no currency symbol).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "transactions.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b4500\b/ },
  ],
};
