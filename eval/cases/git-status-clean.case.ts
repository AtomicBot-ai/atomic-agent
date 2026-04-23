import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

export const gitStatusClean: EvalCase = {
  id: "git-status-clean",
  name: "Inspect a clean git repo with git.status",
  category: "os",
  prompt:
    "Check the git status of this directory and tell me whether the working tree is clean. Reply with the single word `clean` or `dirty`.",
  setup: ({ workingDir }) => {
    const opts = { cwd: workingDir, stdio: "ignore" } as const;
    execFileSync("git", ["init", "-q", "-b", "main"], opts);
    execFileSync("git", ["config", "user.email", "eval@local"], opts);
    execFileSync("git", ["config", "user.name", "Eval"], opts);
    writeFileSync(join(workingDir, "README.md"), "# clean\n", "utf8");
    execFileSync("git", ["add", "."], opts);
    execFileSync(
      "git",
      ["commit", "-q", "-m", "initial", "--allow-empty"],
      opts,
    );
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.git.status", mustSucceed: true },
    { kind: "reply_contains", pattern: /\bclean\b/i },
  ],
};
