import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// One definition + two call sites. Task: rename `oldFn` → `computeTotal`
// across all three files. Exercises grep-then-edit at scale.
const FILES: Record<string, string> = {
  "src/math.ts": [
    "export function oldFn(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
  ].join("\n"),
  "src/summary.ts": [
    "import { oldFn } from \"./math.js\";",
    "",
    "export function summarise(values: number[]): number {",
    "  return values.reduce((acc, v) => oldFn(acc, v), 0);",
    "}",
    "",
  ].join("\n"),
  "src/cli.ts": [
    "import { oldFn } from \"./math.js\";",
    "",
    "console.log(oldFn(2, 3));",
    "",
  ].join("\n"),
};

export const codingRenameFunctionAcrossFiles: EvalCase = {
  id: "coding-rename-function-across-files",
  name: "Rename oldFn to computeTotal across three files",
  category: "coding",
  prompt: `Rename the function oldFn to computeTotal everywhere it appears under src/. Update the definition AND every import / call site. After the rename, no occurrence of oldFn must remain in any .ts file.`,
  maxSteps: 25,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    for (const [rel, body] of Object.entries(FILES)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
  },
  expectations: [
    {
      kind: "file_matches",
      path: "src/math.ts",
      pattern: /export\s+function\s+computeTotal\s*\(/,
    },
    {
      kind: "file_matches",
      path: "src/summary.ts",
      pattern: /import\s+\{\s*computeTotal\s*\}/,
    },
    {
      kind: "file_matches",
      path: "src/cli.ts",
      pattern: /computeTotal\s*\(\s*2/,
    },
    // None of the three files may still mention oldFn. The `s` flag
    // (dotAll) makes `.` cross newlines so the lookahead scans the
    // whole file body, not just the first line.
    {
      kind: "file_matches",
      path: "src/math.ts",
      pattern: /^(?!.*oldFn).*$/s,
    },
    {
      kind: "file_matches",
      path: "src/summary.ts",
      pattern: /^(?!.*oldFn).*$/s,
    },
    {
      kind: "file_matches",
      path: "src/cli.ts",
      pattern: /^(?!.*oldFn).*$/s,
    },
  ],
};
