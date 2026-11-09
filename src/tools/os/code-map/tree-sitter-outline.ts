import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COMMON_WORDS,
  signatureOf,
  type CodeLanguage,
  type FileOutline,
  type OutlineBackend,
  type OutlineSymbol,
  type SymbolKind,
} from "./outline-types.js";

/**
 * Optional tree-sitter backend for `os.fs.code_map`.
 *
 * `web-tree-sitter` is NOT a dependency of this package (adding it and
 * the grammar WASMs to the SEA / desktop bundles is an open decision,
 * +3–6 MB). This module therefore imports it lazily by a non-literal
 * specifier, so neither the type checker nor the bundler resolves it, and
 * answers `null` whenever the module or a grammar is missing; the code
 * map then stays on the regex backend without a word to the model.
 *
 * Grammars are read from one directory (`ATOMIC_AGENT_TREE_SITTER_DIR`)
 * under their upstream file names, e.g. `tree-sitter-typescript.wasm`.
 * A language whose WASM is absent is simply not `supports`-ed.
 */

const GRAMMAR_FILES: Readonly<Record<CodeLanguage, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
};

/** Minimal structural view of a web-tree-sitter node (0.20–0.25). */
interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number };
  namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null;
}
interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: TsNode; delete?: () => void } | null;
}

const DECLARATIONS: Readonly<Record<string, SymbolKind>> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  function_definition: "function",
  class_definition: "class",
  method_declaration: "method",
  type_spec: "type",
  function_item: "function",
  struct_item: "struct",
  enum_item: "enum",
  trait_item: "trait",
  impl_item: "impl",
  mod_item: "module",
  type_item: "type",
  const_item: "const",
  static_item: "const",
  record_declaration: "class",
  method_definition: "method",
  method_signature: "method",
  abstract_method_signature: "method",
  public_field_definition: "method",
  constructor_declaration: "method",
};

const BODIES = new Set(["class_body", "interface_body", "declaration_list", "block", "object_type", "enum_body"]);
const IDENTIFIER_TYPES = new Set(["identifier", "type_identifier", "property_identifier", "field_identifier", "shorthand_property_identifier"]);

function nameOf(node: TsNode): string | null {
  const named = node.childForFieldName("name") ?? node.childForFieldName("type");
  if (named) return named.text.split("<")[0]!.trim() || null;
  return null;
}

function exportedOf(node: TsNode, name: string, language: CodeLanguage, parentExported: boolean): boolean {
  if (language === "go") return /^[A-Z]/.test(name);
  if (language === "python") return !name.startsWith("_");
  if (language === "rust") return node.namedChildren.some((c) => c.type === "visibility_modifier");
  if (language === "java") return /\bpublic\b/.test(node.text.slice(0, 200).split("{")[0] ?? "");
  return parentExported;
}

function walkIdentifiers(node: TsNode, into: Map<string, number>, budget: { left: number }): void {
  if (budget.left-- <= 0) return;
  if (IDENTIFIER_TYPES.has(node.type)) {
    const word = node.text;
    if (word.length >= 3 && !COMMON_WORDS.has(word)) into.set(word, (into.get(word) ?? 0) + 1);
    return;
  }
  for (const child of node.namedChildren) walkIdentifiers(child, into, budget);
}

export function outlineFromTree(root: TsNode, source: string, language: CodeLanguage): FileOutline {
  const lines = source.split("\n");
  const symbols: OutlineSymbol[] = [];
  const add = (node: TsNode, kind: SymbolKind, depth: 0 | 1, exported: boolean, nameNode: TsNode = node): boolean => {
    const name = nameOf(nameNode);
    if (!name) return false;
    const row = node.startPosition.row;
    symbols.push({ name, kind, line: row + 1, depth, exported: exportedOf(nameNode, name, language, exported), signature: signatureOf(lines[row] ?? "") });
    return true;
  };
  const visitTop = (node: TsNode, exported: boolean): void => {
    if (node.type === "export_statement") {
      for (const child of node.namedChildren) visitTop(child, true);
      return;
    }
    if (node.type === "decorated_definition") {
      const inner = node.childForFieldName("definition");
      if (inner) visitTop(inner, exported);
      return;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const value = decl.childForFieldName("value");
        const kind: SymbolKind = value && /function|arrow_function/.test(value.type) ? "function" : "const";
        add(node, kind, 0, exported, decl);
      }
      return;
    }
    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) if (spec.type === "type_spec") add(spec, "type", 0, exported);
      return;
    }
    const kind = DECLARATIONS[node.type];
    if (!kind || !add(node, kind === "method" ? "method" : kind, 0, exported)) return;
    const parentExported = symbols[symbols.length - 1]!.exported;
    const body = node.childForFieldName("body") ?? node.namedChildren.find((c) => BODIES.has(c.type));
    if (!body || (kind !== "class" && kind !== "interface" && kind !== "impl" && kind !== "trait")) return;
    for (const member of body.namedChildren) {
      const target = member.type === "decorated_definition" ? member.childForFieldName("definition") ?? member : member;
      const memberKind = DECLARATIONS[target.type];
      if (memberKind === "method" || memberKind === "function") add(target, "method", 1, parentExported);
    }
  };
  for (const child of root.namedChildren) visitTop(child, language === "python" || language === "go" || language === "java");
  const mentions = new Map<string, number>();
  walkIdentifiers(root, mentions, { left: 200_000 });
  return { language, symbols, mentions, lineCount: lines.length };
}

/**
 * Try to build the tree-sitter backend. `null` when `grammarDir` is
 * unset, `web-tree-sitter` is not installed, or nothing loads.
 */
export async function loadTreeSitterBackend(
  grammarDir: string | undefined,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<OutlineBackend | null> {
  if (!grammarDir) return null;
  try {
    const mod = (await importModule("web-tree-sitter")) as Record<string, unknown> & { default?: Record<string, unknown> };
    const ParserCtor = (mod.Parser ?? mod.default ?? mod) as {
      init?: () => Promise<void>;
      Language?: { load(path: string): Promise<unknown> };
      new (): TsParser;
    };
    const Language = (mod.Language ?? ParserCtor.Language) as { load(path: string): Promise<unknown> } | undefined;
    if (typeof ParserCtor !== "function" || !Language) return null;
    await ParserCtor.init?.();
    const languages = new Map<CodeLanguage, unknown>();
    for (const [lang, file] of Object.entries(GRAMMAR_FILES) as [CodeLanguage, string][]) {
      const path = join(grammarDir, file);
      if (!existsSync(path)) continue;
      try {
        languages.set(lang, await Language.load(path));
      } catch {
        // A broken grammar costs that language only.
      }
    }
    if (languages.size === 0) return null;
    const parser = new ParserCtor();
    return {
      id: "tree-sitter",
      supports: (language) => languages.has(language),
      outline(source, language) {
        parser.setLanguage(languages.get(language));
        const tree = parser.parse(source);
        if (!tree) throw new Error("tree-sitter returned no tree");
        try {
          return outlineFromTree(tree.rootNode, source, language);
        } finally {
          tree.delete?.();
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Tree-sitter for the languages it loaded, regex for the rest — and for
 * any file tree-sitter throws on.
 */
export function combineBackends(primary: OutlineBackend | null, fallback: OutlineBackend): OutlineBackend {
  if (!primary) return fallback;
  return {
    id: `${primary.id}+${fallback.id}`,
    supports: () => true,
    async outline(source, language) {
      if (primary.supports(language)) {
        try {
          return await primary.outline(source, language);
        } catch {
          // fall through to the heuristic parser
        }
      }
      return fallback.outline(source, language);
    },
  };
}
