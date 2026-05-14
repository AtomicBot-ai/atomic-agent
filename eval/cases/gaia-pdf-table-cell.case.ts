import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: extract a single table cell from a one-page PDF.
 * Tests `os.fs.read_document` precision and arithmetic-free fact
 * retrieval. The buggy failure mode is the agent answering with a
 * different quarter's revenue (e.g. Q4 = 9.0) — the prompt is
 * deliberately specific about Q3.
 *
 * Known answer: 8.4 (millions USD).
 */
export const gaiaPdfTableCell: EvalCase = {
  id: "gaia-pdf-table-cell",
  name: "Read Q3 revenue from quarterly-report.pdf",
  category: "gaia-style",
  prompt:
    "There is a file `quarterly-report.pdf` in the working directory. Read it and tell me the Q3 revenue figure. Reply with just the number (no currency symbol, no units).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "quarterly-report.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b8\.4\b/ },
  ],
};
