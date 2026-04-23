import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

export const explainTreeShape: EvalCase = {
  id: "explain-tree-shape",
  name: "Describe a small project tree structure (judge)",
  category: "os",
  prompt:
    "Look at the contents of this directory (top level + one level deep) and describe its structure to a colleague. Cover: how many top-level entries, what kinds of files dominate, and whether there is a tests folder. Keep it under 60 words.",
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    const tests = join(workingDir, "tests");
    mkdirSync(src, { recursive: true });
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(workingDir, "package.json"), "{}\n", "utf8");
    writeFileSync(join(workingDir, "README.md"), "# demo\n", "utf8");
    writeFileSync(join(src, "index.ts"), "export const v = 1;\n", "utf8");
    writeFileSync(join(src, "loader.ts"), "export const l = 2;\n", "utf8");
    writeFileSync(join(src, "parser.ts"), "export const p = 3;\n", "utf8");
    writeFileSync(join(tests, "loader.test.ts"), "// test\n", "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.list", mustSucceed: true },
    {
      kind: "judge",
      threshold: 4,
      rubric: [
        "The reply must mention that there is a `tests/` directory (or equivalent test folder).",
        "It must mention that `.ts` / TypeScript files dominate inside `src/`.",
        "It must give a numeric count of top-level entries (4 here: package.json, README.md, src/, tests/).",
        "Score 1 if the reply is empty, hallucinates files that do not exist, or claims the project has no tests.",
        "Score 5 if it also notes the package.json and README.md at top level.",
      ].join(" "),
    },
  ],
};
