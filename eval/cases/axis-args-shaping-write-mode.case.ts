import type { EvalCase } from "../harness/case-schema.js";

// AXIS: args_shaping.
// os.fs.write requires `mode: "create" | "replace" | "append"`. A common
// args_shaping failure is to omit `mode` or pass an invalid value, which
// surfaces as `tool_errors > 0` and a parse-retry round-trip.
export const axisArgsShapingWriteMode: EvalCase = {
  id: "axis-args-shaping-write-mode",
  name: "Create a new file with os.fs.write (correct mode + path)",
  category: "os",
  capabilityAxis: "args_shaping",
  prompt: `Create a new file at notes/welcome.md with EXACTLY the contents "hello from eval" followed by a single newline. Do not append to anything that already exists.`,
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.write", mustSucceed: true },
    { kind: "file_exists", path: "notes/welcome.md" },
    {
      kind: "file_matches",
      path: "notes/welcome.md",
      pattern: /^hello from eval\s*$/,
    },
    { kind: "parse_retries_max", max: 0 },
  ],
};
