import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style HARD: long-context navigation without section pointers.
 *
 * Same fixture as `gaia-pdf-deep-needle` (the 12-page compliance
 * handbook), but the prompt deliberately omits the "Section 4.1"
 * hint and rephrases the question in user-natural language. The
 * agent must skim the whole document, identify the relevant
 * subsection on its own, and isolate the threshold.
 *
 * Failure modes:
 *   - skipping a `os.fs.read_document` call entirely and guessing
 *     (e.g. "$5000 is a common threshold");
 *   - reading only page 1 / TOC and giving up;
 *   - latching onto the salary number (75000) or severance cap
 *     (50000) because they're easier to find.
 *
 * Known answer: 2500.
 */
export const gaiaHardVaguePrompt: EvalCase = {
  id: "gaia-hard-vague-prompt",
  name: "Find air-travel CFO threshold WITHOUT section pointer",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There is a `compliance-handbook.pdf` in the working directory. What's the rule for high-value air travel — at what cost does it need extra approval? Reply with just the dollar amount as an integer (no currency, no comma).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "compliance-handbook.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b2500\b/ },
    // Negative: defend against the agent latching onto the wrong
    // dollar figure in the doc.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b75000\b)(?!.*\b50000\b)(?!.*\b1500\b)(?!.*\b60\b).*$/is,
    },
  ],
};
