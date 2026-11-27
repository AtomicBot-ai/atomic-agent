const NAME = "os.code.lsp";

/**
 * `os.code.lsp` (ATO-2373): code navigation through a real language
 * server (definition, references, hover, symbols). Import-free like the
 * other contracts, so the prompt catalog and the schema map read it
 * without pulling the tool in. Registered only with `tools.lsp.enabled`.
 */
export const OS_CODE_LSP_CONTRACT = {
  name: NAME,
  description:
    "Code navigation through the project's language server, like an IDE. `action`: `definition` (where the symbol at `path`:`line`:`col` is defined), `references` (every use of it), `hover` (its type and docs), `symbols` (the outline of `path`; with `query`, symbols of that name across the project). `line` and `col` are 1-based; without `col`, `query` names the symbol on that line, otherwise its first word is used. Answers `path:line:col: code` per hit, capped by `maxResults` (default 50). Uses a server already on PATH (typescript-language-server, pyright-langserver, gopls, rust-analyzer, clangd, jdtls, sourcekit-lsp, csharp-ls), only inside a git repository; nothing is installed. Read-only.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary:
      "Language-server navigation: definition, references, hover or symbols of the code at path:line:col (1-based). Prefer it to grep for finding where a name is defined or used.",
    argsSchema:
      "{ action: \"definition\"|\"references\"|\"hover\"|\"symbols\", path: string, line?: number, col?: number, query?: string, maxResults?: number }",
    examples: [
      "{\"action\":\"definition\",\"path\":\"src/app.ts\",\"line\":42,\"query\":\"loadConfig\"}",
      "{\"action\":\"symbols\",\"path\":\"src/app.ts\"}",
    ],
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["definition", "references", "hover", "symbols"] },
      path: { type: "string" },
      line: { type: "number" },
      col: { type: "number" },
      query: { type: "string" },
      maxResults: { type: "number" },
    },
    required: ["action", "path"],
    additionalProperties: false,
  },
} as const;
