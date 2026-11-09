import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: tool_error_recovery.
// Companion to axis-recovery-bad-path-then-fix, which covers a failed
// file read. Here a command exits non-zero and says what is missing.
// The build id is derived from a hash, so the marker cannot be guessed
// and only appears once the agent has fixed the input and run it again.
const BUILD_ID = `BUILD-${createHash("sha256")
  .update("ready:exam")
  .digest("hex")
  .slice(0, 8)
  .toUpperCase()}`;

const REPORT_SCRIPT = `const { existsSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const input = join(__dirname, "..", "data", "input.txt");
const word = existsSync(input) ? readFileSync(input, "utf8").trim() : null;
if (word !== "ready") {
  console.error("error: data/input.txt must exist and contain the single word: ready");
  process.exit(1);
}
const id = createHash("sha256").update(word + ":exam").digest("hex").slice(0, 8);
console.log("BUILD-" + id.toUpperCase());
`;

export const axisRecoveryFailedCommand: EvalCase = {
  id: "axis-recovery-failed-command",
  name: "Recover from a failed command by acting on its error",
  category: "os",
  capabilityAxis: "tool_error_recovery",
  prompt:
    "Run `node tools/report.js` in this directory and reply with the build id it prints. If the command fails, read its error, fix what it asks for, and run it again.",
  setup: ({ workingDir }) => {
    mkdirSync(join(workingDir, "tools"), { recursive: true });
    writeFileSync(join(workingDir, "tools", "report.js"), REPORT_SCRIPT, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.shell.run", mustSucceed: true },
    { kind: "file_matches", path: "data/input.txt", pattern: /^ready\s*$/ },
    { kind: "reply_contains", pattern: new RegExp(BUILD_ID) },
  ],
};
