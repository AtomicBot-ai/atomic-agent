import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: set-difference across two XLSX files. The agent must
 * hold two sets in working memory and compute `inventory \ orders-q4`.
 *
 * inventory.xlsx Manufacturer column = {Acme, Globex, Initech,
 *   Umbrella, Stark} (5 distinct).
 * orders-q4.xlsx Manufacturer column = {Acme, Globex, Umbrella,
 *   Stark} (4 distinct — Initech is absent).
 *
 * Known answer: Initech. Two `reply_contains` chains keep the test
 * strict: positive on Initech, negative on the four other names so
 * a "let me list all 5" dump fails.
 */
export const gaiaXlsxWhichIsMissing: EvalCase = {
  id: "gaia-xlsx-which-is-missing",
  name: "Find manufacturer with zero Q4 orders (set-difference)",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There are two files in the working directory: `inventory.xlsx` lists manufacturers, and `orders-q4.xlsx` lists Q4 orders by manufacturer. Which manufacturer appears in inventory.xlsx but has ZERO orders in orders-q4.xlsx? Reply with just the manufacturer name (one word).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "inventory.xlsx");
    copyGaiaFixture(workingDir, "orders-q4.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\bInitech\b/i },
    // Negative: a dump of "all 5 manufacturers" must fail. The
    // distractor names (Acme, Globex, Umbrella, Stark) must not
    // appear in the reply.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\bAcme\b)(?!.*\bGlobex\b)(?!.*\bUmbrella\b)(?!.*\bStark\b).*$/is,
    },
  ],
};
