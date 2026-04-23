import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

export const fsGlobTypescript: EvalCase = {
  id: "fs-glob-typescript",
  name: "Glob *.ts files and count them",
  category: "os",
  prompt:
    "List every `.ts` file in this directory tree (any depth) and tell me how many you found. End with the literal phrase `total: <N>` where N is the count.",
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    const lib = join(workingDir, "lib", "deep");
    mkdirSync(src, { recursive: true });
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(src, "alpha.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(src, "beta.ts"), "export const b = 2;\n", "utf8");
    writeFileSync(join(lib, "gamma.ts"), "export const g = 3;\n", "utf8");
    writeFileSync(join(workingDir, "README.md"), "# noise\n", "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.glob", mustSucceed: true },
    { kind: "reply_contains", pattern: /total:\s*3/i },
  ],
};
