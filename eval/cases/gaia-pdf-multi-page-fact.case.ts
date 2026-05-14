import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: locate a fact on a specific page of a multi-page PDF.
 * Tests page-indexed reading + section-aware extraction. The
 * fixture deliberately interleaves three other unrelated tenure
 * tiers (14, 16, 18 days) so a sloppy reader picks the wrong number.
 *
 * Known answer: 21 (working days per year).
 */
export const gaiaPdfMultiPageFact: EvalCase = {
  id: "gaia-pdf-multi-page-fact",
  name: "Find vacation days for 5+ year tenure in policy-handbook.pdf",
  category: "gaia-style",
  prompt:
    "Open `policy-handbook.pdf` in the working directory. Section 3 lists paid leave by tenure. How many working days of paid leave per year does an employee with MORE than 5 years of service receive? Reply with just the integer.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "policy-handbook.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b21\b/ },
  ],
};
