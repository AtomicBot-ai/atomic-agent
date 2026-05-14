import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// `firstName(user)` dereferences a possibly-undefined `user.name`.
// Fix: guard against null/undefined and return empty string (or any
// non-throwing fallback).
const USER_SOURCE = [
  "export interface User { name?: string }",
  "",
  "export function firstName(user: User): string {",
  "  return user.name.split(\" \")[0];",
  "}",
  "",
].join("\n");

export const codingFixMissingNullCheck: EvalCase = {
  id: "coding-fix-missing-null-check",
  name: "Add a null guard so firstName never throws",
  category: "coding",
  prompt: `src/user.ts crashes when user.name is undefined. Fix firstName so it returns an empty string instead of throwing. Keep the existing behaviour when user.name is a normal string.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "user.ts"), USER_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      // Accept any reasonable null-guard pattern. Variants observed in
      // the wild include `user?.name?.split(...) ?? ""` (qwen-3.5-9b
      // adds optional chaining on `user` itself), `user.name?.split(...)`,
      // explicit `=== undefined` / `== null`, ternary, and simple `!`.
      kind: "file_matches",
      path: "src/user.ts",
      pattern: /user\??\.name\s*\?\.|user\.name\s*===\s*undefined|!\s*user\??\.name|user\??\.name\s*\?\s*\S|user\??\.name\s*==\s*null/,
    },
  ],
};
