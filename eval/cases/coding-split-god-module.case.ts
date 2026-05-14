import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// `src/everything.ts` lumps a parser and a formatter together. Task:
// split into `parser.ts` + `formatter.ts`, and turn `everything.ts`
// into a barrel that re-exports both. Tests larger refactor planning.
const EVERYTHING_SOURCE = [
  "// Mixed bag — should be split into parser.ts + formatter.ts.",
  "export function parseAmount(raw: string): number {",
  "  return Number.parseFloat(raw);",
  "}",
  "",
  "export function formatAmount(amount: number): string {",
  "  return amount.toFixed(2);",
  "}",
  "",
].join("\n");

export const codingSplitGodModule: EvalCase = {
  id: "coding-split-god-module",
  name: "Split everything.ts into parser.ts + formatter.ts barrel",
  category: "coding",
  prompt: `Refactor src/everything.ts: move parseAmount into src/parser.ts and formatAmount into src/formatter.ts. Then rewrite src/everything.ts so it only re-exports both functions (barrel pattern). All three files must be present and consistent.`,
  maxSteps: 25,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "everything.ts"), EVERYTHING_SOURCE, "utf8");
  },
  expectations: [
    { kind: "file_exists", path: "src/parser.ts" },
    { kind: "file_exists", path: "src/formatter.ts" },
    {
      kind: "file_matches",
      path: "src/parser.ts",
      pattern: /export\s+function\s+parseAmount/,
    },
    {
      kind: "file_matches",
      path: "src/formatter.ts",
      pattern: /export\s+function\s+formatAmount/,
    },
    {
      kind: "file_matches",
      path: "src/everything.ts",
      pattern: /export\s*\{[^}]*parseAmount[^}]*\}\s*from\s*["']\.\/parser|export\s*\*\s*from\s*["']\.\/parser/,
    },
    {
      kind: "file_matches",
      path: "src/everything.ts",
      pattern: /export\s*\{[^}]*formatAmount[^}]*\}\s*from\s*["']\.\/formatter|export\s*\*\s*from\s*["']\.\/formatter/,
    },
  ],
};
