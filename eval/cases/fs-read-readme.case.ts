import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

const README = [
  "# Project Phoenix",
  "",
  "The launch date is **2031-04-12**.",
  "Operating budget is $128,500.",
  "",
].join("\n");

export const fsReadReadme: EvalCase = {
  id: "fs-read-readme",
  name: "Read launch date from README.md",
  category: "os",
  prompt:
    "Open README.md in this directory and tell me the project's launch date. Reply with just the date in YYYY-MM-DD form.",
  setup: ({ workingDir }) => {
    writeFileSync(join(workingDir, "README.md"), README, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "reply_contains", pattern: /2031-04-12/ },
  ],
};
