import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: instruction_adherence.
// Prompt explicitly forbids shell — the agent must reach for
// filesystem tools instead. This catches "everything looks like a
// shell nail" behaviour that some models default to.
const TREE: Record<string, string> = {
  "src/a.ts": "// a\n",
  "src/b.ts": "// b\n",
  "src/c.md": "# notes\n",
};

export const axisInstructionNoShell: EvalCase = {
  id: "axis-instruction-no-shell",
  name: "List files in src/ using ONLY filesystem tools, not shell",
  category: "os",
  capabilityAxis: "instruction_adherence",
  prompt: `List the files in src/ and reply with their names separated by commas. IMPORTANT: do NOT use any shell command. Use only the filesystem tools.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    for (const [rel, body] of Object.entries(TREE)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
  },
  expectations: [
    { kind: "tool_not_invoked", tool: "os.shell.run" },
    { kind: "reply_contains", pattern: /a\.ts/ },
    { kind: "reply_contains", pattern: /b\.ts/ },
    { kind: "reply_contains", pattern: /c\.md/ },
  ],
};
