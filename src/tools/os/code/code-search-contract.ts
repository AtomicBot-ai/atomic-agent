const NAME = "os.code.search";

/**
 * `os.code.search` (ATO-696): structural (syntax-aware) code search
 * through the ast-grep CLI. Import-free like the fs contracts, so the
 * prompt catalog and the schema map read it without pulling the tool in.
 */
export const OS_CODE_SEARCH_CONTRACT = {
  name: NAME,
  description:
    "Structural code search with ast-grep: `pattern` is code with metavariables (`$NAME` one node, `$$$ARGS` any number), matched against the syntax tree, so comments and strings never match and formatting does not matter. Example: `console.log($$$A)` finds every console.log call. `lang` sets the language (typescript, tsx, javascript, python, go, rust, java, ...), otherwise it comes from each file's extension. Needs the `ast-grep` CLI on PATH (or ATOMIC_AGENT_AST_GREP_PATH); without it the call says how to install it. Read-only.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary:
      "Syntax-aware code search (ast-grep): pattern is code with $VAR / $$$ARGS metavariables, e.g. `useState($INIT)`; no false hits in comments or strings. Needs the ast-grep CLI.",
    argsSchema:
      "{ pattern: string, lang?: string, path?: string, globs?: string[], maxResults?: number, timeoutMs?: number }",
    tier: "rare",
    examples: [
      "{\"pattern\":\"console.log($$$A)\",\"lang\":\"typescript\",\"path\":\"src\"}",
    ],
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      lang: { type: "string" },
      path: { type: "string" },
      globs: { type: "array", items: { type: "string" } },
      maxResults: { type: "number" },
      timeoutMs: { type: "number" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
} as const;
