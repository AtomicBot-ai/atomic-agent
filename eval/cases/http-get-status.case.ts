import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

export const httpGetStatus: EvalCase = {
  id: "http-get-status",
  name: "GET the local mock /status and report the service field",
  category: "http",
  requires: ["mock-http"],
  prompt: [
    "There is a local HTTP server. Read the URL from the file `MOCK_URL.txt` in this directory.",
    "Make a GET request to `<URL>/status` and tell me the value of the `service` field in the JSON response.",
    "Reply with the literal value of `service` and nothing else.",
  ].join(" "),
  setup: ({ workingDir, mockHttpUrl }) => {
    if (mockHttpUrl === null) return;
    writeFileSync(join(workingDir, "MOCK_URL.txt"), `${mockHttpUrl}\n`, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.http.request", mustSucceed: true },
    { kind: "reply_contains", pattern: /\beval\b/ },
  ],
};
