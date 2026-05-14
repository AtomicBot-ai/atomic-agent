import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Single-file rename — easier than a tree-walk shell rename and well
// inside the 5-step budget. Forces the agent to use a write + delete
// pair (or shell `mv`) since there is no dedicated `os.fs.move` tool.
export const osFsRenameMdToMdx: EvalCase = {
  id: "os-fs-rename-md-to-mdx",
  name: "Rename docs/index.md to docs/index.mdx (preserve content)",
  category: "os",
  prompt: `Rename docs/index.md to docs/index.mdx. The file content must stay byte-for-byte identical. After the rename, the old .md file must no longer exist.`,
  setup: ({ workingDir }) => {
    const dir = join(workingDir, "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.md"),
      "# Atomic Agent\n\nWelcome.\n",
      "utf8",
    );
  },
  expectations: [
    { kind: "file_exists", path: "docs/index.mdx" },
    {
      kind: "file_matches",
      path: "docs/index.mdx",
      pattern: /# Atomic Agent[\s\S]*Welcome\./,
    },
  ],
};
