import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: cross-document reasoning. The base figure (100 000)
 * lives in budget-2023.pdf and the multiplier (1.15) lives in
 * budget-revision-2024.pdf. The agent must read BOTH documents
 * (parallel batch is the natural shape) and then compute the
 * product. Failure modes seen in the wild: replying with just the
 * base, replying with just the percentage, or computing a 15-percent
 * delta only (15 000) instead of the full revised total.
 *
 * Known answer: 115 000 (USD).
 */
export const gaiaPdfCrossDocArithmetic: EvalCase = {
  id: "gaia-pdf-cross-doc-arithmetic",
  name: "Compute revised 2024 budget across two PDFs",
  category: "gaia-style",
  prompt:
    "There are two files in the working directory: `budget-2023.pdf` and `budget-revision-2024.pdf`. Read both and tell me the revised engineering budget for fiscal year 2024 in USD. Reply with just the integer (no commas, no currency symbol).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "budget-2023.pdf");
    copyGaiaFixture(workingDir, "budget-revision-2024.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b115[\s,]?000\b/ },
  ],
};
