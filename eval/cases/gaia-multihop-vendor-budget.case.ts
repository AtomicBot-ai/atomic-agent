import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: multi-hop reasoning across two file formats. The agent
 * must first read `vendors.pdf` to identify the "vendor of the year"
 * for 2024 (Globex), then look up Globex's March spend in
 * `budgets.xlsx`.
 *
 * The naive failure modes:
 *   - skip the PDF and just dump March numbers for all vendors (the
 *     reply contains 12000 but also other amounts);
 *   - read only the PDF and reply with the vendor name instead of
 *     the March spend;
 *   - confuse March with another column.
 *
 * Known answer: 12000. (Globex Mar in budgets.xlsx; the value is
 * unique across the sheet so a model that reads both files and
 * names the right vendor will land on this number.)
 */
export const gaiaMultihopVendorBudget: EvalCase = {
  id: "gaia-multihop-vendor-budget",
  name: "Find vendor-of-year (PDF) then their March spend (XLSX)",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There are two files in the working directory: `vendors.pdf` names the 'vendor of the year' for 2024, and `budgets.xlsx` records monthly spend per vendor. How much did the vendor of the year spend in March? Reply with just the integer (no currency, no commas).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "vendors.pdf");
    copyGaiaFixture(workingDir, "budgets.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b12000\b/ },
    // Negative: rejecting "I'll list every vendor's March spend"
    // — Acme Mar = 6000, Initech Mar = 3300, Umbrella Mar = 4900,
    // Stark Mar = 7500. None of these should appear in a strict
    // single-number reply.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b6000\b)(?!.*\b3300\b)(?!.*\b4900\b)(?!.*\b7500\b).*$/is,
    },
  ],
};
