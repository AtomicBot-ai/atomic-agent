import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Three Python files with a deterministic total line count. The agent
// has to discover all `.py`, read or `wc -l` them, sum, and report the
// number. Mimics the AgentBench OS "summarise a directory" pattern.
const FILES: Record<string, string> = {
  "a.py": "x = 1\ny = 2\nprint(x + y)\n",
  "b.py": "def square(n):\n    return n * n\n",
  "nested/c.py": "import sys\nfor line in sys.stdin:\n    print(line.strip())\n",
};

const TOTAL_LINES = Object.values(FILES).reduce(
  (acc, body) => acc + body.split("\n").filter((line) => line.length > 0).length,
  0,
);

export const osFsCountPyLines: EvalCase = {
  id: "os-fs-count-py-lines",
  name: "Count non-empty lines across all Python files",
  category: "os",
  prompt: `Count the total number of non-empty lines across every .py file in the working directory tree. Reply with a single integer.`,
  setup: ({ workingDir }) => {
    for (const [rel, body] of Object.entries(FILES)) {
      const full = join(workingDir, rel);
      mkdirSync(join(full, "..").trim(), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
  },
  expectations: [
    { kind: "reply_contains", pattern: new RegExp(`\\b${TOTAL_LINES}\\b`) },
  ],
};
