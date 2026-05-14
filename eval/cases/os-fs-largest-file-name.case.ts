import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Three files with deterministic sizes. The biggest is `big.log` by a
// wide margin. Asserts that the agent identifies the largest file by
// name, exercising `os.fs.list` (with sizes) or shell `ls -lS`.
const FILES: Record<string, string> = {
  "small.log": "a\n",
  "medium.log": "a".repeat(512) + "\n",
  "big.log": "a".repeat(8192) + "\n",
};

export const osFsLargestFileName: EvalCase = {
  id: "os-fs-largest-file-name",
  name: "Identify the largest file in the working directory",
  category: "os",
  prompt: `Which file in the working directory has the largest size on disk? Reply with just the file name (no path).`,
  setup: ({ workingDir }) => {
    for (const [rel, body] of Object.entries(FILES)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
    mkdirSync(join(workingDir, ".keep-empty"), { recursive: true });
  },
  expectations: [
    { kind: "reply_contains", pattern: /\bbig\.log\b/ },
  ],
};
