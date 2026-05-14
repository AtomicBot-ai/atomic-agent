import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// A compact JSON config schema. Judge confirms the agent surfaced the
// three top-level keys and at least one constraint per the schema.
const SCHEMA_SOURCE = JSON.stringify(
  {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["host", "port", "retries"],
    properties: {
      host: { type: "string", description: "DNS host or IP" },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      retries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
    },
    additionalProperties: false,
  },
  null,
  2,
);

export const judgeSummarizeConfigSchema: EvalCase = {
  id: "judge-summarize-config-schema",
  name: "Summarise a small JSON Schema",
  category: "os",
  prompt: `Read config.schema.json in the working directory. In 2-4 sentences, summarise its shape: which top-level fields exist, which are required, and any value constraints.`,
  setup: ({ workingDir }) => {
    writeFileSync(join(workingDir, "config.schema.json"), SCHEMA_SOURCE, "utf8");
    mkdirSync(join(workingDir, ".keep"), { recursive: true });
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "judge",
      threshold: 4,
      rubric: `The reply MUST mention all three top-level fields (host, port, retries). It MUST also mention at least two of these constraints: required={host,port,retries}; port range 1..65535; retries range 0..10; additionalProperties=false; retries default=3. Missing the three fields or naming wrong fields is an automatic 1 or 2.`,
    },
  ],
};
