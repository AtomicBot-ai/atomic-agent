import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Two directories share exactly one filename: `config.yml`. The agent
// must discover the overlap. Tests planner + cross-tree comparison.
const TREE: Record<string, string> = {
  "left/config.yml": "side: left\n",
  "left/readme.md": "left side\n",
  "right/config.yml": "side: right\n",
  "right/secrets.env": "API_KEY=xxx\n",
};

export const osFsFindDuplicateFilenames: EvalCase = {
  id: "os-fs-find-duplicate-filenames",
  name: "Find filenames that appear in both left/ and right/",
  category: "os",
  prompt: `Look at the directories left/ and right/. Tell me which filenames appear in BOTH directories (just the base name).`,
  setup: ({ workingDir }) => {
    for (const [rel, body] of Object.entries(TREE)) {
      const full = join(workingDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
  },
  expectations: [
    { kind: "reply_contains", pattern: /config\.yml/ },
  ],
};
