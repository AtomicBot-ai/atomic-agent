import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

export const httpPostEcho: EvalCase = {
  id: "http-post-echo",
  name: "POST a payload to the local /echo endpoint",
  category: "http",
  requires: ["mock-http"],
  prompt: [
    "There is a local HTTP server; its URL is in the file `MOCK_URL.txt`.",
    'POST the JSON body `{"token":"ECHO-7711"}` to `<URL>/echo`.',
    "The server returns a JSON object with a `received` field that contains your body verbatim.",
    "Reply with the literal token from the response (the value of `token`).",
  ].join(" "),
  setup: ({ workingDir, mockHttpUrl }) => {
    if (mockHttpUrl === null) return;
    writeFileSync(join(workingDir, "MOCK_URL.txt"), `${mockHttpUrl}\n`, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.http.request", mustSucceed: true },
    { kind: "reply_contains", pattern: /ECHO-7711/ },
  ],
};
