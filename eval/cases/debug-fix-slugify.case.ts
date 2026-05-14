import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

const SLUG_SOURCE = [
  "export function slugify(input: string): string {",
  "  return input.trim().replace(/\\s+/g, \"_\");",
  "}",
  "",
].join("\n");

const SLUG_TEST = [
  "import { describe, expect, it } from \"vitest\";",
  "import { slugify } from \"./slug.js\";",
  "",
  "describe(\"slugify\", () => {",
  "  it(\"normalizes titles for URLs\", () => {",
  "    expect(slugify(\"  Hello Atomic Agent  \")).toBe(\"hello-atomic-agent\");",
  "    expect(slugify(\"Retry, Repair, Repeat!\")).toBe(\"retry-repair-repeat\");",
  "  });",
  "});",
  "",
].join("\n");

export const debugFixSlugify: EvalCase = {
  id: "debug-fix-slugify",
  name: "Debug a failing slugify test without editing the test",
  category: "debug",
  prompt:
    "The slugify tests are failing. Inspect src/slug.ts and src/slug.test.ts, then fix the implementation only. Do not edit the test file. Tell me the fix.",
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "slug.ts"), SLUG_SOURCE, "utf8");
    writeFileSync(join(src, "slug.test.ts"), SLUG_TEST, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "file_matches", path: "src/slug.ts", pattern: /toLowerCase\(\)/ },
    { kind: "file_matches", path: "src/slug.ts", pattern: /replace\([^)]*\[\\\^?a-z0-9|replace\([^)]*a-z0-9/i },
    { kind: "file_matches", path: "src/slug.test.ts", pattern: /Retry, Repair, Repeat!/ },
  ],
};
