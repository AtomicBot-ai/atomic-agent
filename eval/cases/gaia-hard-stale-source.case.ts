import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style HARD: choose current source when multiple conflicting
 * versions live in the same workspace.
 *
 * Two compliance handbooks coexist:
 *   - `compliance-handbook.pdf` — CURRENT (2024 edition,
 *     threshold = 2500).
 *   - `compliance-handbook-2022.pdf` — LEGACY (2022 edition,
 *     threshold = 1000). Page 1 explicitly says "superseded".
 *
 * The naive failure modes:
 *   - reading either file in isolation and reporting whichever
 *     threshold appears first;
 *   - taking the smaller (more conservative) value to be safe;
 *   - replying with both values ("either 1000 or 2500 depending
 *     on edition").
 *
 * Known answer: 2500. The current edition supersedes the 2022
 * one, which the legacy file itself spells out on page 1.
 */
export const gaiaHardStaleSource: EvalCase = {
  id: "gaia-hard-stale-source",
  name: "Pick current source over legacy (conflicting thresholds)",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There are two compliance handbooks in the working directory. What is the CURRENT dollar threshold above which air travel requires CFO approval? Reply with just the integer (no currency, no comma).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "compliance-handbook.pdf");
    copyGaiaFixture(workingDir, "compliance-handbook-2022.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b2500\b/ },
    // Negative: reject "1000" (legacy answer) and the "1000 or 2500"
    // hedge. Other noise numbers from both docs are filtered too.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b1000\b)(?!.*\b65000\b)(?!.*\b25000\b).*$/is,
    },
  ],
};
