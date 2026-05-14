import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { EvalCase } from "../harness/case-schema.js";

// Tests the `os.fs.hash` rare tool (requires `tool.view` to autoload its
// args schema). The expected SHA-256 is precomputed from the same string
// we drop on disk so the assertion is deterministic across hosts.
const FILE_BODY = "atomic-agent eval seed: 9f81-4d2b-c773\n";
const EXPECTED_SHA256 = createHash("sha256")
  .update(FILE_BODY, "utf8")
  .digest("hex");

export const osFsHashSha256: EvalCase = {
  id: "os-fs-hash-sha256",
  name: "Compute the SHA-256 hash of a small file",
  category: "os",
  prompt: `Compute the SHA-256 hash of seed.txt and reply with the hex digest only (lowercase, no prefix).`,
  setup: ({ workingDir }) => {
    writeFileSync(join(workingDir, "seed.txt"), FILE_BODY, "utf8");
  },
  expectations: [
    { kind: "reply_contains", pattern: new RegExp(EXPECTED_SHA256) },
  ],
};
