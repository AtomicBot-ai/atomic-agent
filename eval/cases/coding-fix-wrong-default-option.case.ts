import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// `parseOptions` defaults `verbose` to `true`, which surprises every
// caller. The fix is to default it to `false` (the documented behaviour
// per the in-file comment).
const OPTIONS_SOURCE = [
  "// CLI options. `verbose` MUST default to false so a clean run is",
  "// silent. Today it defaults to true and breaks every consumer.",
  "export interface Options {",
  "  verbose?: boolean;",
  "}",
  "",
  "export function parseOptions(input: Options): Required<Options> {",
  "  return { verbose: input.verbose ?? true };",
  "}",
  "",
].join("\n");

export const codingFixWrongDefaultOption: EvalCase = {
  id: "coding-fix-wrong-default-option",
  name: "Default verbose to false instead of true",
  category: "coding",
  prompt: `src/options.ts has a wrong default — the comment says verbose must default to false but the code defaults to true. Fix the default. Keep the function name and signature.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "options.ts"), OPTIONS_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "file_matches",
      path: "src/options.ts",
      pattern: /verbose\s*:\s*input\.verbose\s*\?\?\s*false|input\.verbose\s*===\s*true/,
    },
  ],
};
