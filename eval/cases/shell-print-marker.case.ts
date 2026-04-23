import type { EvalCase } from "../harness/case-schema.js";

export const shellPrintMarker: EvalCase = {
  id: "shell-print-marker",
  name: "Run `echo` via shell and report the marker",
  category: "os",
  prompt:
    'Run a shell command that prints the literal string `EVAL-OK-9237` to stdout (using `echo`). Then reply with the same marker.',
  expectations: [
    { kind: "tool_invoked", tool: "os.shell.run", mustSucceed: true },
    { kind: "reply_contains", pattern: /EVAL-OK-9237/ },
  ],
};
