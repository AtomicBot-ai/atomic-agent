import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Two files duplicate the same retry-limit literal `3`. Task: extract it
// into src/constants.ts as MAX_RETRIES and import it from both call
// sites. Forces multi-file plan + at least one create + two edits.
const FILES: Record<string, string> = {
  "src/uploader.ts": [
    "export async function upload(payload: unknown): Promise<void> {",
    "  for (let attempt = 0; attempt < 3; attempt += 1) {",
    "    await tryOnce(payload);",
    "  }",
    "}",
    "async function tryOnce(_: unknown): Promise<void> {}",
    "",
  ].join("\n"),
  "src/downloader.ts": [
    "export async function download(url: string): Promise<string> {",
    "  let body = \"\";",
    "  for (let attempt = 0; attempt < 3; attempt += 1) {",
    "    body = await tryFetch(url);",
    "    if (body) break;",
    "  }",
    "  return body;",
    "}",
    "async function tryFetch(_: string): Promise<string> { return \"\"; }",
    "",
  ].join("\n"),
};

export const codingExtractSharedConstant: EvalCase = {
  id: "coding-extract-shared-constant",
  name: "Extract a duplicated literal into a shared MAX_RETRIES constant",
  category: "coding",
  prompt: `Both src/uploader.ts and src/downloader.ts hardcode the retry count 3. Create src/constants.ts exporting MAX_RETRIES = 3, then have both files import and use MAX_RETRIES instead of the literal 3. Keep the public APIs unchanged.`,
  maxSteps: 20,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    for (const [rel, body] of Object.entries(FILES)) {
      writeFileSync(join(workingDir, rel), body, "utf8");
    }
  },
  expectations: [
    { kind: "file_exists", path: "src/constants.ts" },
    {
      kind: "file_matches",
      path: "src/constants.ts",
      pattern: /export\s+const\s+MAX_RETRIES\s*=\s*3/,
    },
    {
      kind: "file_matches",
      path: "src/uploader.ts",
      pattern: /import\s+\{\s*MAX_RETRIES\s*\}/,
    },
    {
      kind: "file_matches",
      path: "src/uploader.ts",
      pattern: /<\s*MAX_RETRIES/,
    },
    {
      kind: "file_matches",
      path: "src/downloader.ts",
      pattern: /import\s+\{\s*MAX_RETRIES\s*\}/,
    },
    {
      kind: "file_matches",
      path: "src/downloader.ts",
      pattern: /<\s*MAX_RETRIES/,
    },
  ],
};
