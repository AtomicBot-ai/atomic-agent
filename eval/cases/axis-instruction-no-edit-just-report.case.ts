import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: instruction_adherence.
// The prompt explicitly forbids modification. Even though the file has
// a juicy bug, the agent MUST only report. This pairs (anti-axis-style)
// with the existing coding-fix-* cases where edits ARE expected.
const BUGGY = [
  "export function isAdult(age: number): boolean {",
  "  // BUG: off-by-one — should be >= 18, not > 18.",
  "  return age > 18;",
  "}",
  "",
].join("\n");

export const axisInstructionNoEditJustReport: EvalCase = {
  id: "axis-instruction-no-edit-just-report",
  name: "Identify a bug WITHOUT modifying any file",
  category: "coding",
  capabilityAxis: "instruction_adherence",
  prompt: `Look at src/age.ts. It has a bug. EXPLAIN the bug in your reply. DO NOT modify any file. DO NOT run any shell command. Only read.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "age.ts"), BUGGY, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "reply_contains", pattern: /(off[- ]by[- ]one|>=\s*18|should be.*18|inclusive)/i },
    { kind: "tool_not_invoked", tool: "os.fs.write" },
    { kind: "tool_not_invoked", tool: "os.fs.edit" },
    { kind: "tool_not_invoked", tool: "os.fs.trash" },
    { kind: "tool_not_invoked", tool: "os.shell.run" },
  ],
};
