import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: tool_error_recovery.
// The prompt confidently asserts a WRONG path. The real file lives
// elsewhere. A capable agent will (a) try the stated path, (b) hit an
// error, (c) discover the file via list/glob, (d) succeed. We assert
// that os.fs.read both errored once AND succeeded once.
export const axisRecoveryBadPathThenFix: EvalCase = {
  id: "axis-recovery-bad-path-then-fix",
  name: "Recover from a bad path by discovering the real file",
  category: "os",
  capabilityAxis: "tool_error_recovery",
  prompt: `Open the file src/widget.ts and tell me the name of the function it exports. (If you cannot find it there, look around — it might be elsewhere.)`,
  setup: ({ workingDir }) => {
    const dir = join(workingDir, "lib");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "widget.ts"),
      "export function makeWidget(): number { return 42; }\n",
      "utf8",
    );
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "reply_contains", pattern: /makeWidget/ },
  ],
};
