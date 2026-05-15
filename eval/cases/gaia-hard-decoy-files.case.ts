import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style HARD: file selection out of N candidates.
 *
 * The workspace is seeded with FIVE unrelated PDFs. Only one
 * (`quarterly-report.pdf`) contains the answer; the rest are
 * decoys (`policy-handbook.pdf`, `compliance-handbook.pdf`,
 * `vendors.pdf`, `org-chart.pdf`). The prompt does NOT name the
 * source file — the agent must pick it.
 *
 * Failure modes:
 *   - `os.fs.read_document` on the wrong file and guessing from
 *     unrelated content;
 *   - blindly reading every file and timing out;
 *   - replying without reading anything ("typical Q3 revenue is
 *     around 7-8M USD" hallucination).
 *
 * Known answer: 8.4.
 */
export const gaiaHardDecoyFiles: EvalCase = {
  id: "gaia-hard-decoy-files",
  name: "Pick the right file from 5 candidates (no file name in prompt)",
  category: "gaia-style",
  capabilityAxis: "tool_selection",
  prompt:
    "There are several PDF files in the working directory. What was the company's Q3 revenue figure for 2024? Reply with just the number.",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "quarterly-report.pdf");
    copyGaiaFixture(workingDir, "policy-handbook.pdf");
    copyGaiaFixture(workingDir, "compliance-handbook.pdf");
    copyGaiaFixture(workingDir, "vendors.pdf");
    copyGaiaFixture(workingDir, "org-chart.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b8\.4\b/ },
    // Negative: defend against the agent picking another quarter's
    // figure (Q1 6.2, Q2 7.1, Q4 9.0) or numbers from unrelated
    // decoy docs (75000, 12000, 50000).
    {
      kind: "reply_contains",
      pattern: /^(?!.*\b6\.2\b)(?!.*\b7\.1\b)(?!.*\b9\.0\b)(?!.*\b75000\b)(?!.*\b50000\b).*$/is,
    },
  ],
};
