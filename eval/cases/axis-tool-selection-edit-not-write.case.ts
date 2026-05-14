import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: tool_selection.
// Single targeted change — agent SHOULD use os.fs.edit (preserves the
// rest of the file deterministically), NOT os.fs.write (which forces
// rewriting the entire file from memory and is the lossy choice).
const SOURCE = [
  "export interface Counter {",
  "  current: number;",
  "}",
  "",
  "export function bump(counter: Counter): number {",
  "  return counter.current + 2;",
  "}",
  "",
].join("\n");

export const axisToolSelectionEditNotWrite: EvalCase = {
  id: "axis-tool-selection-edit-not-write",
  name: "Pick os.fs.edit for a one-line patch instead of os.fs.write",
  category: "coding",
  capabilityAxis: "tool_selection",
  prompt: `Fix the single bug in src/counter.ts: bump must add 1, not 2. Make a TARGETED edit — do not rewrite the whole file. Use os.fs.edit for a string-replace patch.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "counter.ts"), SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.edit", mustSucceed: true },
    { kind: "tool_not_invoked", tool: "os.fs.write" },
    {
      kind: "file_matches",
      path: "src/counter.ts",
      pattern: /current\s*\+\s*1\b/,
    },
  ],
};
