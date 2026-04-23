import type { EvalCase } from "../harness/case-schema.js";

export const fsCreateChangelog: EvalCase = {
  id: "fs-create-changelog",
  name: "Create CHANGELOG.md with a single bullet",
  category: "os",
  prompt:
    "Create a file called CHANGELOG.md in this directory. Inside, write a single line: `- v0.1.0: initial eval entry`. After writing, tell me you are done.",
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.write", mustSucceed: true },
    { kind: "file_exists", path: "CHANGELOG.md" },
    { kind: "file_matches", path: "CHANGELOG.md", pattern: /v0\.1\.0/i },
  ],
};
