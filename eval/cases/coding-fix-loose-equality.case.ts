import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// The comparator uses `==` (loose equality), causing `"0" == 0` and
// other coercion surprises. Fix is to use `===` strict equality.
const COMPARATOR_SOURCE = [
  "export function sameId(a: unknown, b: unknown): boolean {",
  "  return a == b;",
  "}",
  "",
].join("\n");

export const codingFixLooseEquality: EvalCase = {
  id: "coding-fix-loose-equality",
  name: "Replace loose equality with strict equality",
  category: "coding",
  prompt: `src/sameId.ts uses loose equality (==) and that lets sameId("0", 0) return true. Tighten the comparator to use strict equality so type coercion no longer fires. Keep the API the same.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "sameId.ts"), COMPARATOR_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "file_matches", path: "src/sameId.ts", pattern: /a\s*===\s*b/ },
  ],
};
