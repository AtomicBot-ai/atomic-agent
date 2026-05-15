import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: JOIN across two XLSX sheets via a foreign key. The
 * `Customers` sheet maps `CustomerId → Name`; the `Orders` sheet has
 * `OrderId, CustomerId, Amount`. The agent must locate the row with
 * the maximum Amount and then resolve the corresponding name from
 * the other sheet.
 *
 * Largest single order (see orders-multisheet.xlsx in
 * build-fixtures.mjs): O103, CustomerId C3, Amount 9999. C3 maps
 * to "Initech LLC".
 *
 * Known answer: Initech LLC. Failure modes: replying with the
 * CustomerId (`C3`), the order id (`O103`), or another customer
 * because the agent confused max-row with max-aggregated-sum.
 */
export const gaiaXlsxMultisheetJoin: EvalCase = {
  id: "gaia-xlsx-multisheet-join",
  name: "JOIN Customers + Orders to find owner of largest single order",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "Open `orders-multisheet.xlsx` in the working directory. The `Customers` sheet maps customer IDs to names; the `Orders` sheet lists individual orders with amounts. Find the customer who placed the single largest order (largest Amount in the Orders sheet), and reply with their full Name from the Customers sheet. No ID, no amount — just the name.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "orders-multisheet.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\bInitech\s+LLC\b/i },
    // Negative: the other 4 customer names must not appear (catches
    // table-dump replies).
    {
      kind: "reply_contains",
      pattern: /^(?!.*\bAcme\s+Corp\b)(?!.*\bGlobex\s+Industries\b)(?!.*\bUmbrella\s+Group\b)(?!.*\bStark\s+Enterprises\b).*$/is,
    },
  ],
};
