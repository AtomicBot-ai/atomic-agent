import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

const README = [
  "# Aurora Edge Cache",
  "",
  "Aurora is a CDN-side edge cache for AI inference responses. It sits in front",
  "of any OpenAI-compatible chat-completion endpoint and serves cached responses",
  "for repeated prompt hashes, with a tunable TTL and per-tenant isolation.",
  "",
  "## Highlights",
  "",
  "- **Prompt-hash keying** with a salted SHA-256 to avoid cross-tenant collisions.",
  "- **Streaming-aware**: caches the first chunk's tokens and replays the SSE.",
  "- **TTL by default 5 minutes**, override per request via `x-aurora-ttl`.",
  "- **No data is stored beyond the TTL window.**",
  "",
].join("\n");

export const summarizeReadme: EvalCase = {
  id: "summarize-readme",
  name: "Summarise an unfamiliar README in one sentence (judge)",
  category: "os",
  prompt:
    "Read README.md in this directory and summarise the project in a single sentence (max 25 words). Reply with just the sentence — no preamble, no list.",
  setup: ({ workingDir }) => {
    writeFileSync(join(workingDir, "README.md"), README, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "judge",
      threshold: 4,
      rubric: [
        "The reply must be ONE sentence (no bullet list, no multi-paragraph).",
        "It must mention that Aurora is an edge cache for AI / LLM / inference responses.",
        "It must NOT invent features absent from the README (e.g. no 'GPU', no 'training').",
        "Score 5 only if it also captures one concrete trait (TTL, prompt-hashing, streaming, or per-tenant isolation).",
        "Score 1 if the reply is empty, refuses, or quotes the README verbatim without summarising.",
      ].join(" "),
    },
  ],
};
