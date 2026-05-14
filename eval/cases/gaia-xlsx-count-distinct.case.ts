import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: count-distinct over a single XLSX column. The
 * fixture has two sheets (`Inventory` + `QA — Notes`). Only the
 * Inventory sheet's Manufacturer column should be counted —
 * sloppy readers that skim both sheets will hallucinate extra
 * "manufacturers" from the audit notes. Each manufacturer is
 * spelled identically across rows so no fuzzy matching is needed.
 *
 * Known answer: 5 distinct manufacturers (Acme, Globex, Initech,
 * Umbrella, Stark).
 */
export const gaiaXlsxCountDistinct: EvalCase = {
  id: "gaia-xlsx-count-distinct",
  name: "Count distinct manufacturers in inventory.xlsx",
  category: "gaia-style",
  prompt:
    "Open `inventory.xlsx` in the working directory. On the Inventory sheet, how many distinct values appear in the Manufacturer column? Reply with just the integer.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "inventory.xlsx");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b5\b/ },
  ],
};
