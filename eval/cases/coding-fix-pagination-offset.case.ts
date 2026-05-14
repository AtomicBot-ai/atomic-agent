import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Classic off-by-one bug: pagination uses 1-based page numbers but
// computes a 0-based offset incorrectly. Fix: subtract 1 from page (or
// multiply by `page - 1`).
const PAGINATION_SOURCE = [
  "export function pageOffset(page: number, pageSize: number): number {",
  "  return page * pageSize;",
  "}",
  "",
].join("\n");

export const codingFixPaginationOffset: EvalCase = {
  id: "coding-fix-pagination-offset",
  name: "Fix an off-by-one bug in pagination offset",
  category: "coding",
  prompt: `src/pagination.ts has an off-by-one bug: with page=1 and pageSize=20 it returns 20 instead of 0. Fix pageOffset so that page 1 yields offset 0 and page 2 yields offset pageSize. Keep the public signature unchanged.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "pagination.ts"), PAGINATION_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "file_matches",
      path: "src/pagination.ts",
      pattern: /\(\s*page\s*-\s*1\s*\)\s*\*\s*pageSize|page\s*\*\s*pageSize\s*-\s*pageSize/,
    },
  ],
};
