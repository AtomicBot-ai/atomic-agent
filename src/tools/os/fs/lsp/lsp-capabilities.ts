/**
 * What the client tells a language server it understands in
 * `initialize`: diagnostics for the after-edit check (ATO-503), and the
 * four navigation requests of `os.code.lsp` (ATO-2373). `linkSupport`
 * lets a server answer a definition with `LocationLink`s, and
 * hierarchical document symbols come back as a tree.
 */
export const LSP_CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: false, dynamicRegistration: false },
    publishDiagnostics: { versionSupport: true },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
    },
  },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    symbol: { dynamicRegistration: false },
  },
} as const;
