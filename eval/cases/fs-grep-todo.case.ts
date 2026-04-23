import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

const FILE_A = "function add(a, b) { return a + b; }\n";
const FILE_B = "// TODO(eval): wire up the streaming parser before launch\n";
const FILE_C = "// no work needed here\n";

export const fsGrepTodo: EvalCase = {
  id: "fs-grep-todo",
  name: "Grep for TODO marker across source files",
  category: "os",
  prompt:
    "Find every line in this directory containing the marker `TODO(eval)` and tell me which file it lives in.",
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "math.ts"), FILE_A, "utf8");
    writeFileSync(join(src, "parser.ts"), FILE_B, "utf8");
    writeFileSync(join(src, "noop.ts"), FILE_C, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.grep", mustSucceed: true },
    { kind: "reply_contains", pattern: /parser\.ts/ },
  ],
};
