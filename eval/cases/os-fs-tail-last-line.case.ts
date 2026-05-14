import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// app.log ends with a unique sentinel line containing a 7-digit marker.
// The agent has to read (or tail) the file and surface that exact
// marker. Tests offset/limit reading or shell tail.
const LOG = [
  "[INFO]  service started",
  "[INFO]  warming caches",
  "[WARN]  slow query 1.2s",
  "[INFO]  cache warmed",
  "[INFO]  request id=42",
  "[INFO]  request id=43",
  "[ERROR] final tail marker EVAL-TAIL-3194885",
  "",
].join("\n");

export const osFsTailLastLine: EvalCase = {
  id: "os-fs-tail-last-line",
  name: "Read the final marker line from a log file",
  category: "os",
  prompt: `Open app.log and tell me the value of the marker on its final non-empty line. Reply with just the marker token (the one that looks like EVAL-TAIL-XXXXXXX).`,
  setup: ({ workingDir }) => {
    writeFileSync(join(workingDir, "app.log"), LOG, "utf8");
  },
  expectations: [
    { kind: "reply_contains", pattern: /EVAL-TAIL-3194885/ },
  ],
};
