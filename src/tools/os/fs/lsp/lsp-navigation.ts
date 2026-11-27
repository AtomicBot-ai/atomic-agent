/**
 * The four navigation questions of `os.code.lsp` (ATO-2373), asked of a
 * running language server: where is this defined, who uses it, what is
 * it (hover), and which symbols exist. The answers are normalised to
 * plain hits (path, 1-based line and column, an optional label) so the
 * formatter never sees the LSP shapes: `Location`, `LocationLink`,
 * `DocumentSymbol` trees, `SymbolInformation`, `WorkspaceSymbol` and the
 * three spellings of hover contents.
 *
 * Precedent: Claude Code's LSP tool (goToDefinition, findReferences,
 * hover, documentSymbol) and OpenCode's `lsp` tool.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiagnosticsClient } from "./lsp-client.js";

export const LSP_NAV_ACTIONS = ["definition", "references", "hover", "symbols"] as const;
export type LspNavAction = (typeof LSP_NAV_ACTIONS)[number];

/** More hits than this are not even parsed: the formatter shows far fewer. */
export const MAX_PARSED_HITS = 2000;
/** Document symbol trees are flattened this deep (0 = top level). */
const MAX_SYMBOL_DEPTH = 3;

export interface LspHit {
  /** Absolute path, or null for a non-file URI (`jdt://…`). */
  readonly path: string | null;
  readonly uri: string;
  /** 1-based; 0 when the server gave no range (a workspace symbol). */
  readonly line: number;
  readonly col: number;
  /** `function main`, `class Foo (in pkg)`: symbols only. */
  readonly label?: string;
  /** Nesting in a document symbol tree. */
  readonly depth?: number;
}

export type LspNavAnswer =
  | { readonly kind: "hits"; readonly hits: readonly LspHit[] }
  | { readonly kind: "hover"; readonly text: string | null };

export interface LspNavRequest {
  readonly action: LspNavAction;
  readonly absolute: string;
  readonly languageId: string;
  /** The file's current text, synced to the server before asking. */
  readonly text: string;
  /** 0-based, as LSP counts (UTF-16 units, the same as JS strings). */
  readonly line: number;
  readonly character: number;
  /** For `symbols`: a name to look up across the workspace. */
  readonly query?: string;
}

export async function navigate(
  client: DiagnosticsClient,
  req: LspNavRequest,
  timeoutMs: number,
): Promise<LspNavAnswer> {
  if (client.sync === undefined || client.request === undefined) {
    throw new Error("this language server connection cannot answer navigation requests");
  }
  client.sync(req.absolute, req.languageId, req.text);
  const uri = pathToFileURL(req.absolute).href;
  const textDocument = { uri };
  const position = { line: req.line, character: req.character };
  switch (req.action) {
    case "definition":
      return {
        kind: "hits",
        hits: parseLocations(
          await client.request("textDocument/definition", { textDocument, position }, timeoutMs),
        ),
      };
    case "references":
      return {
        kind: "hits",
        hits: parseLocations(
          await client.request(
            "textDocument/references",
            { textDocument, position, context: { includeDeclaration: true } },
            timeoutMs,
          ),
        ),
      };
    case "hover":
      return {
        kind: "hover",
        text: parseHover(
          await client.request("textDocument/hover", { textDocument, position }, timeoutMs),
        ),
      };
    case "symbols": {
      const query = req.query?.trim() ?? "";
      if (query.length > 0) {
        return {
          kind: "hits",
          hits: parseSymbols(await client.request("workspace/symbol", { query }, timeoutMs), uri),
        };
      }
      return {
        kind: "hits",
        hits: parseSymbols(
          await client.request("textDocument/documentSymbol", { textDocument }, timeoutMs),
          uri,
        ),
      };
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

/** Absolute path of a `file:` URI, or null for any other scheme. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function hit(uri: string, range: unknown, extra: Pick<LspHit, "label" | "depth"> = {}): LspHit {
  const start = record(record(range)?.start);
  const rawLine = start?.line;
  const rawCol = start?.character;
  const line = typeof rawLine === "number" ? rawLine + 1 : 0;
  const col = typeof rawCol === "number" ? rawCol + 1 : 0;
  return { path: uriToPath(uri), uri, line, col, ...extra };
}

/** `Location | Location[] | LocationLink[] | null` as hits. */
export function parseLocations(result: unknown): LspHit[] {
  const out: LspHit[] = [];
  for (const item of asList(result)) {
    if (out.length >= MAX_PARSED_HITS) break;
    const r = record(item);
    if (r === null) continue;
    if (typeof r.targetUri === "string") {
      out.push(hit(r.targetUri, r.targetSelectionRange ?? r.targetRange));
    } else if (typeof r.uri === "string") {
      out.push(hit(r.uri, r.range));
    }
  }
  return out;
}

const SYMBOL_KINDS = [
  "", "file", "module", "namespace", "package", "class", "method", "property",
  "field", "constructor", "enum", "interface", "function", "variable", "constant",
  "string", "number", "boolean", "array", "object", "key", "null", "enum member",
  "struct", "event", "operator", "type parameter",
];

function symbolLabel(r: Record<string, unknown>): string {
  const kind = typeof r.kind === "number" ? (SYMBOL_KINDS[r.kind] ?? "") : "";
  const name = typeof r.name === "string" ? r.name : "?";
  const container =
    typeof r.containerName === "string" && r.containerName.length > 0
      ? ` (in ${r.containerName})`
      : "";
  return `${kind.length > 0 ? `${kind} ` : ""}${name}${container}`;
}

/**
 * `DocumentSymbol[]` (a tree, in `docUri`), `SymbolInformation[]` or
 * `WorkspaceSymbol[]` (each with its own location) as hits.
 */
export function parseSymbols(result: unknown, docUri: string): LspHit[] {
  const out: LspHit[] = [];
  const walk = (items: unknown[], depth: number): void => {
    for (const item of items) {
      if (out.length >= MAX_PARSED_HITS) return;
      const r = record(item);
      if (r === null) continue;
      const location = record(r.location);
      if (location !== null && typeof location.uri === "string") {
        out.push(hit(location.uri, location.range, { label: symbolLabel(r) }));
        continue;
      }
      if (r.range === undefined && r.selectionRange === undefined) continue;
      out.push(hit(docUri, r.selectionRange ?? r.range, { label: symbolLabel(r), depth }));
      if (Array.isArray(r.children) && depth < MAX_SYMBOL_DEPTH) walk(r.children, depth + 1);
    }
  };
  walk(asList(result), 0);
  return out;
}

/** Hover contents (`MarkupContent`, `MarkedString`, or a list of them) as text. */
export function parseHover(result: unknown): string | null {
  const contents = record(result)?.contents;
  if (contents === undefined || contents === null) return null;
  const parts: string[] = [];
  for (const part of asList(contents)) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const r = record(part);
    if (r === null || typeof r.value !== "string") continue;
    // `{ language, value }` is a code block; `{ kind, value }` is already text.
    parts.push(typeof r.language === "string" ? `\`\`\`${r.language}\n${r.value}\n\`\`\`` : r.value);
  }
  const text = parts.map((p) => p.trim()).filter((p) => p.length > 0).join("\n\n");
  return text.length > 0 ? text : null;
}
