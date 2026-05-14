import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// `daysBetween(later, earlier)` was implemented as `earlier - later`,
// returning a negative count for any forward range. Fix: swap the
// operands so the result is `later - earlier`.
const DATE_SOURCE = [
  "export function daysBetween(later: Date, earlier: Date): number {",
  "  const ms = earlier.getTime() - later.getTime();",
  "  return Math.round(ms / (1000 * 60 * 60 * 24));",
  "}",
  "",
].join("\n");

export const codingFixSwappedDateArgs: EvalCase = {
  id: "coding-fix-swapped-date-args",
  name: "Fix swapped operands in daysBetween",
  category: "coding",
  prompt: `src/date-diff.ts returns negative numbers for forward ranges because the subtraction order is reversed. Fix daysBetween so daysBetween(new Date("2030-01-10"), new Date("2030-01-01")) returns 9, not -9. Keep the public signature unchanged.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "date-diff.ts"), DATE_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "file_matches",
      path: "src/date-diff.ts",
      pattern: /later\.getTime\(\)\s*-\s*earlier\.getTime\(\)/,
    },
  ],
};
