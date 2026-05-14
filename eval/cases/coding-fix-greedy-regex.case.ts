import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// `extractFirstTag` uses a greedy `.+` and ends up capturing across
// multiple `<...>` blocks. Fix: make it lazy (`.+?`) or restrict the
// character class to non-angle-bracket characters.
const REGEX_SOURCE = [
  "export function extractFirstTag(html: string): string | null {",
  "  const m = html.match(/<(.+)>/);",
  "  return m ? m[1] : null;",
  "}",
  "",
].join("\n");

export const codingFixGreedyRegex: EvalCase = {
  id: "coding-fix-greedy-regex",
  name: "Make extractFirstTag regex non-greedy",
  category: "coding",
  prompt: `src/extract.ts has a greedy regex. For input "<a><b>" it captures "a><b" instead of "a". Fix the regex so extractFirstTag returns only the first tag's contents. Keep the function signature.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "extract.ts"), REGEX_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "file_matches",
      path: "src/extract.ts",
      // Accept any non-greedy quantifier (`.+?` or `.*?`) or restricted
      // character class. `.*?` is semantically valid for the stated
      // input and is what qwen-3.5-9b emits in practice.
      pattern: /<\(\.[+*]\?\)>|<\(\[\^>\]\+\)>|<\(\[\^<>\]\+\)>/,
    },
  ],
};
