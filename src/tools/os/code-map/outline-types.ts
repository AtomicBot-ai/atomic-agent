/**
 * Shared shapes for `os.fs.code_map` (ATO-652).
 *
 * An outline is what a parser can say about one source file without
 * running it: the symbols it defines (top level, plus members one level
 * down) and the identifiers it mentions. The ranker turns mentions into
 * references between files; the renderer prints the symbols.
 */

export type CodeLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "method"
  | "struct"
  | "trait"
  | "impl"
  | "module";

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the declaration. */
  line: number;
  /** 0 = top level, 1 = member of a class/impl/interface. */
  depth: 0 | 1;
  /** Visible outside the file (export / pub / public / Uppercase / no `_`). */
  exported: boolean;
  /** The declaration line, trimmed and cut before its body. */
  signature: string;
}

export interface FileOutline {
  language: CodeLanguage;
  symbols: OutlineSymbol[];
  /** Identifier mentions in the file (declarations included), by name. */
  mentions: Map<string, number>;
  lineCount: number;
}

/**
 * A parser behind the code map. The regex backend is always there; the
 * tree-sitter one is optional (`tree-sitter-outline.ts`) and only used
 * for the languages whose grammar it could load.
 */
export interface OutlineBackend {
  /** Short id, part of the cache key (`regex`, `tree-sitter`). */
  readonly id: string;
  supports(language: CodeLanguage): boolean;
  outline(source: string, language: CodeLanguage): FileOutline | Promise<FileOutline>;
}

const EXTENSIONS: ReadonlyMap<string, CodeLanguage> = new Map([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
]);

/** The language of a file by name, or `null` for a file the map skips. */
export function languageForPath(path: string): CodeLanguage | null {
  const lower = path.toLowerCase();
  // Declarations and bundles restate code that lives elsewhere.
  if (lower.endsWith(".d.ts") || lower.endsWith(".min.js")) return null;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS.get(lower.slice(dot)) ?? null;
}

/** Words that look like identifiers but carry no cross-file meaning. */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  "abstract", "async", "await", "boolean", "break", "case", "catch", "class",
  "const", "continue", "default", "def", "delete", "else", "enum", "export",
  "extends", "false", "final", "finally", "for", "from", "func", "function",
  "if", "impl", "implements", "import", "in", "instanceof", "interface", "let",
  "match", "mod", "new", "nil", "None", "null", "number", "package", "private",
  "protected", "pub", "public", "return", "self", "Self", "static", "string",
  "struct", "super", "switch", "this", "throw", "trait", "true", "True", "False",
  "try", "type", "typeof", "undefined", "use", "var", "void", "while", "with",
  "yield", "lambda", "pass", "raise", "elif", "except", "not", "and", "or",
  "is", "fn", "mut", "ref", "where", "loop", "go", "defer", "chan", "map",
  "range", "select", "int", "float", "bool", "str", "char", "byte", "error",
  "object", "any", "unknown", "never", "readonly", "keyof", "declare", "get",
  "set", "args", "kwargs", "err", "ctx", "value", "key", "name", "data",
]);

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Count identifier mentions in already comment/string-stripped text. */
export function countMentions(text: string, into: Map<string, number> = new Map()): Map<string, number> {
  for (const match of text.matchAll(IDENTIFIER)) {
    const word = match[0];
    if (word.length < 3 || COMMON_WORDS.has(word)) continue;
    into.set(word, (into.get(word) ?? 0) + 1);
  }
  return into;
}

/** A declaration line cut before its body and capped for the prompt. */
export function signatureOf(line: string, max = 120): string {
  let text = line.trim();
  const brace = text.indexOf("{");
  if (brace > 0) text = text.slice(0, brace).trimEnd();
  if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1).trimEnd();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}
