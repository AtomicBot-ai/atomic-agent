const NAME = "os.code.rewrite";

/**
 * `os.code.rewrite` (ATO-696): structural search and replace through
 * the ast-grep CLI, previewed by default and written only after the
 * same approval as the other file writes. Import-free.
 */
export const OS_CODE_REWRITE_CONTRACT = {
  name: NAME,
  description:
    "Structural search and replace with ast-grep: every match of `pattern` (code with `$NAME` / `$$$ARGS` metavariables, matched on the syntax tree, never inside comments or strings) is replaced by `rewrite`, where the same metavariables insert what they matched. Example: pattern `oldName($$$A)`, rewrite `newName($$$A)`. `apply=false` (default) is a DRY-RUN that returns the diff without touching files; `apply=true` writes every changed file at once after approval, or none if any file cannot be changed. Needs the `ast-grep` CLI on PATH (or ATOMIC_AGENT_AST_GREP_PATH).",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary:
      "Syntax-aware search and replace (ast-grep) across files: pattern + rewrite with shared $VAR metavariables. Dry-run diff by default; apply=true writes after approval. Needs the ast-grep CLI.",
    argsSchema:
      "{ pattern: string, rewrite: string, lang?: string, path?: string, globs?: string[], apply?: boolean, timeoutMs?: number }",
    tier: "rare",
    examples: [
      "{\"pattern\":\"oldName($$$A)\",\"rewrite\":\"newName($$$A)\",\"lang\":\"typescript\",\"path\":\"src\"}",
    ],
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      rewrite: { type: "string" },
      lang: { type: "string" },
      path: { type: "string" },
      globs: { type: "array", items: { type: "string" } },
      apply: { type: "boolean" },
      timeoutMs: { type: "number" },
    },
    required: ["pattern", "rewrite"],
    additionalProperties: false,
  },
} as const;
