import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: context_retention.
// The settings file contains a distinctive value (port 49213). The
// agent reads it, then must surface the EXACT value in reply. Failure
// modes: (a) hallucinated value like "8080", (b) generic answer "the
// port is in the file", (c) wrong value due to dropping the latest
// tool-result before the reply step. Asserts the exact integer.
export const axisContextRetentionConfigValue: EvalCase = {
  id: "axis-context-retention-config-value",
  name: "Surface a distinctive value from a freshly read file",
  category: "os",
  capabilityAxis: "context_retention",
  prompt: `Open settings.ini and tell me the exact value of the "port" key. Reply with just the integer.`,
  setup: ({ workingDir }) => {
    writeFileSync(
      join(workingDir, "settings.ini"),
      "[server]\nhost = 0.0.0.0\nport = 49213\ntimeout = 30\n",
      "utf8",
    );
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "reply_contains", pattern: /\b49213\b/ },
  ],
};
