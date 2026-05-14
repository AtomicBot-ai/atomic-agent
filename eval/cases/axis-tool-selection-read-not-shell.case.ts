import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: tool_selection.
// File exists; the right tool is os.fs.read. A common failure mode is
// to fall through to `os.shell.run cat` because the model latched onto
// the verb "show" or "print". This case enforces the preference.
export const axisToolSelectionReadNotShell: EvalCase = {
  id: "axis-tool-selection-read-not-shell",
  name: "Pick os.fs.read over os.shell.run for a plain file read",
  category: "os",
  capabilityAxis: "tool_selection",
  prompt: `Open notes.txt and tell me the value of the line that starts with "key:". Use the filesystem read tool, not a shell command.`,
  setup: ({ workingDir }) => {
    writeFileSync(
      join(workingDir, "notes.txt"),
      "header\nkey: AXIS-OK-7711\nfooter\n",
      "utf8",
    );
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "tool_not_invoked", tool: "os.shell.run" },
    { kind: "reply_contains", pattern: /AXIS-OK-7711/ },
  ],
};
