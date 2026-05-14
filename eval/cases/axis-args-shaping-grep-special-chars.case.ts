import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: args_shaping.
// The marker contains regex metacharacters (parens). Agent must shape
// the grep `pattern` arg correctly (either escape, or use a fixed-
// string variant). A failed args_shape lands as `tool_errors > 0` or
// a successful grep with zero matches followed by a wrong reply.
const FILES: Record<string, string> = {
  "src/alpha.ts": "// nothing here\n",
  "src/beta.ts": "// hit-marker TODO(eval) below\nexport const beta = 1;\n",
  "src/gamma.ts": "// also nothing\n",
};

export const axisArgsShapingGrepSpecialChars: EvalCase = {
  id: "axis-args-shaping-grep-special-chars",
  name: "Grep for a literal token containing regex parens",
  category: "os",
  capabilityAxis: "args_shaping",
  prompt: `Find every file under src/ that contains the LITERAL token "TODO(eval)" (with the parentheses). Reply with the file path of the single matching file.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    for (const [rel, body] of Object.entries(FILES)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.grep", mustSucceed: true },
    // grep can return the path as `src/beta.ts` or `./beta.ts` (when
    // the tool was rooted at `src/`). Accept both — the diagnostic
    // signal is "grep with special chars succeeded", not the prefix
    // shape.
    { kind: "reply_contains", pattern: /(?:src\/|\.\/|^|\s)beta\.ts/ },
  ],
};
