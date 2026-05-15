import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: long-context "needle in a haystack". A 12-page
 * compliance handbook with the answer buried in Section 4.1
 * ("Exceptions") on page 8. All other monetary figures in the
 * document (salary 75000, equipment allowance 1500, severance cap
 * 50000) are intentionally distinct from 2500 so a model that
 * stops at the first dollar amount it grabs lands on the wrong
 * answer.
 *
 * Known answer: 2500 (USD). The agent should read the whole
 * document via `os.fs.read_document` and isolate Section 4.1.
 */
export const gaiaPdfDeepNeedle: EvalCase = {
  id: "gaia-pdf-deep-needle",
  name: "Find CFO-approval threshold buried on page 8 of 12-page handbook",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There is a file `compliance-handbook.pdf` in the working directory. Section 4.1 (Exceptions) lists a dollar threshold above which air travel requires CFO approval. What is that threshold? Reply with just the integer (no currency symbol, no comma).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "compliance-handbook.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b2500\b/ },
    // Negative: defend against the agent confusing this with one of
    // the other monetary figures in the handbook.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b75000\b)(?!.*\b50000\b)(?!.*\b1500\b).*$/is,
    },
  ],
};
