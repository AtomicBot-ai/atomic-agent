import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Three modules with clear import chains. cli.ts imports parser.ts;
// parser.ts imports tokenizer.ts. Question: what does cli.ts depend
// on, directly OR transitively?
const FILES: Record<string, string> = {
  "src/tokenizer.ts": [
    "export function tokenize(input: string): string[] {",
    "  return input.split(/\\s+/).filter(Boolean);",
    "}",
    "",
  ].join("\n"),
  "src/parser.ts": [
    "import { tokenize } from \"./tokenizer.js\";",
    "",
    "export function parse(input: string): string[][] {",
    "  return [tokenize(input)];",
    "}",
    "",
  ].join("\n"),
  "src/cli.ts": [
    "import { parse } from \"./parser.js\";",
    "",
    "console.log(parse(process.argv[2] ?? \"\"));",
    "",
  ].join("\n"),
};

export const judgeFindModuleDependency: EvalCase = {
  id: "judge-find-module-dependency",
  name: "Trace the dependency chain of src/cli.ts",
  category: "os",
  prompt: `What modules under src/ does src/cli.ts depend on, directly or transitively? List them and briefly say which import path each one comes through.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    for (const [rel, body] of Object.entries(FILES)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "judge",
      threshold: 4,
      rubric: `The reply MUST identify BOTH dependencies of src/cli.ts: src/parser.ts (direct) AND src/tokenizer.ts (transitive, via parser). It MUST also indicate that tokenizer is reached through parser (not directly from cli). Missing either file, or claiming cli imports tokenizer directly, is an automatic 1 or 2.`,
    },
  ],
};
