import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// AXIS: parallel_batching.
// Four small independent files. The prompt explicitly asks for all four
// at once, the planner SHOULD pack four reads into a single tool-call
// array (batched step). batch_size_min: 3 leaves slack for one to slip
// without losing the diagnostic signal.
const FILES: Record<string, string> = {
  "data/one.txt": "alpha\n",
  "data/two.txt": "beta\n",
  "data/three.txt": "gamma\n",
  "data/four.txt": "delta\n",
};

export const axisBatchingFourIndependentReads: EvalCase = {
  id: "axis-batching-four-independent-reads",
  name: "Read four independent files in a single batched step",
  category: "os",
  capabilityAxis: "parallel_batching",
  prompt: `Read all four files in data/ (one.txt, two.txt, three.txt, four.txt) IN PARALLEL — they are independent. Then reply with the first word of each, in the order one,two,three,four.`,
  setup: ({ workingDir }) => {
    const dir = join(workingDir, "data");
    mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(FILES)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "batch_size_min", min: 3 },
    { kind: "reply_contains", pattern: /alpha/ },
    { kind: "reply_contains", pattern: /beta/ },
    { kind: "reply_contains", pattern: /gamma/ },
    { kind: "reply_contains", pattern: /delta/ },
  ],
};
