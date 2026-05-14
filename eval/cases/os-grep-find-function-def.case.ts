import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// One TS file defines `parseInvoice`, two other files only reference it.
// Asserts the agent locates the definition (not just usages) — a real
// pattern from "code navigation" agent benchmarks.
const FILES: Record<string, string> = {
  "src/parser.ts": [
    "import type { Invoice } from \"./types.js\";",
    "",
    "export function parseInvoice(raw: string): Invoice {",
    "  return JSON.parse(raw) as Invoice;",
    "}",
    "",
  ].join("\n"),
  "src/types.ts": "export interface Invoice { id: string; total: number; }\n",
  "src/cli.ts": [
    "import { parseInvoice } from \"./parser.js\";",
    "",
    "const inv = parseInvoice(process.argv[2] ?? \"{}\");",
    "console.log(inv);",
    "",
  ].join("\n"),
};

export const osGrepFindFunctionDef: EvalCase = {
  id: "os-grep-find-function-def",
  name: "Locate the file that defines parseInvoice",
  category: "os",
  prompt: `There is a function named parseInvoice somewhere in src/. Tell me the path (relative to the working directory) of the file that DEFINES it, not the files that import it.`,
  setup: ({ workingDir }) => {
    for (const [rel, body] of Object.entries(FILES)) {
      const full = join(workingDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
  },
  expectations: [
    { kind: "reply_contains", pattern: /src\/parser\.ts/ },
  ],
};
