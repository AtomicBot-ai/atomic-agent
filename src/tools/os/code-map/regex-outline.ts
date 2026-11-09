import {
  countMentions,
  signatureOf,
  type CodeLanguage,
  type FileOutline,
  type OutlineBackend,
  type OutlineSymbol,
  type SymbolKind,
} from "./outline-types.js";
import { stripSource } from "./strip-source.js";

/**
 * The default outline backend: line patterns per language over source
 * with comments and string contents blanked (`strip-source.ts`). No
 * dependency, no WASM, good enough for "which files define what": it
 * reads top-level declarations and the members of classes, interfaces,
 * impls and traits one level down, and nothing deeper.
 */
export const regexOutlineBackend: OutlineBackend = {
  id: "regex",
  supports: () => true,
  outline: (source, language) => regexOutline(source, language),
};

const NOT_A_MEMBER = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "super",
  "new", "await", "throw", "else", "do", "try", "typeof", "delete", "case",
  "yield", "import", "export",
]);

interface Container {
  /** Brace depth of the container's body. */
  bodyDepth: number;
  kind: "class" | "interface" | "impl" | "trait" | "struct";
  exported: boolean;
}

export function regexOutline(source: string, language: CodeLanguage): FileOutline {
  const stripped = stripSource(source, language);
  const original = source.split("\n");
  const lines = stripped.split("\n");
  const symbols =
    language === "python"
      ? outlinePython(lines, original)
      : outlineBraced(lines, original, language);
  return {
    language,
    symbols,
    mentions: countMentions(stripped),
    lineCount: original.length,
  };
}

function push(
  out: OutlineSymbol[],
  original: readonly string[],
  index: number,
  name: string,
  kind: SymbolKind,
  depth: 0 | 1,
  exported: boolean,
): void {
  out.push({ name, kind, line: index + 1, depth, exported, signature: signatureOf(original[index] ?? "") });
}

// ── TS / JS ──────────────────────────────────────────────────────────────
const TS_FUNCTION = /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TS_CLASS = /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TS_INTERFACE = /^\s*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const TS_TYPE = /^\s*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/;
const TS_ENUM = /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const TS_CONST = /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(.*)$/;
const TS_ARROWISH = /^(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>|<)/;
const TS_METHOD = /^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set|\*)\s+)*(#?[A-Za-z_$][\w$]*)\s*[?!]?\s*(?:<[^>]*>)?\s*\(/;
const TS_FIELD_FN = /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;

// ── Java ─────────────────────────────────────────────────────────────────
const JAVA_TYPE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\s+)*)(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/;
const JAVA_METHOD = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:<[^>]+>\s+)?(?:[\w.$]+(?:<[^()]*>)?(?:\[\])*\s+)?([A-Za-z_]\w*)\s*\(/;

// ── Go ───────────────────────────────────────────────────────────────────
const GO_METHOD = /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/;
const GO_FUNC = /^func\s+([A-Za-z_]\w*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)?/;
const GO_VALUE = /^(?:var|const)\s+([A-Za-z_]\w*)/;
const GO_IFACE_METHOD = /^\s+([A-Za-z_]\w*)\s*\(/;

// ── Rust ─────────────────────────────────────────────────────────────────
const RS_VIS = String.raw`^\s*(pub(?:\s*\([^)]*\))?\s+)?`;
const RS_FN = new RegExp(`${RS_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_]\\w*)`);
const RS_ITEM = new RegExp(`${RS_VIS}(struct|enum|trait|type|mod|const|static|union)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)`);
const RS_IMPL = /^\s*(?:unsafe\s+)?impl\b(?:\s*<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?&?(?:[\w]+::)*([A-Za-z_]\w*)/;

function isUpper(name: string): boolean {
  const c = name[0] ?? "";
  return c >= "A" && c <= "Z";
}

function outlineBraced(lines: readonly string[], original: readonly string[], language: CodeLanguage): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const stack: Container[] = [];
  // A container declared on a line without its `{` (Allman style): the
  // next line that opens a block at the same depth becomes its body.
  let pending: Omit<Container, "bodyDepth"> & { atDepth: number } | null = null;
  let depth = 0;
  const js = language === "typescript" || language === "tsx" || language === "javascript";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const start = depth;
    while (stack.length > 0 && stack[stack.length - 1]!.bodyDepth > start) stack.pop();
    const container = stack.length > 0 && stack[stack.length - 1]!.bodyDepth === start ? stack[stack.length - 1]! : null;
    let opened: Omit<Container, "bodyDepth"> | null = null;

    if (start === 0) {
      opened = topLevel(line, i, original, out, language, js);
    } else if (container) {
      opened = member(line, i, original, out, language, js, container);
    }

    const opens = count(line, "{");
    const closes = count(line, "}");
    if (opened && opens > 0) stack.push({ ...opened, bodyDepth: start + 1 });
    else if (opened) pending = { ...opened, atDepth: start };
    else if (pending && opens > 0 && pending.atDepth === start) {
      stack.push({ kind: pending.kind, exported: pending.exported, bodyDepth: start + 1 });
      pending = null;
    } else if (pending && /;\s*$/.test(line)) {
      pending = null;
    }
    depth = Math.max(0, start + opens - closes);
  }
  return out;
}

function count(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n++;
  return n;
}

function topLevel(
  line: string,
  i: number,
  original: readonly string[],
  out: OutlineSymbol[],
  language: CodeLanguage,
  js: boolean,
): Omit<Container, "bodyDepth"> | null {
  let m: RegExpExecArray | null;
  if (js) {
    if ((m = TS_CLASS.exec(line))) { push(out, original, i, m[2]!, "class", 0, !!m[1]); return { kind: "class", exported: !!m[1] }; }
    if ((m = TS_INTERFACE.exec(line))) { push(out, original, i, m[2]!, "interface", 0, !!m[1]); return { kind: "interface", exported: !!m[1] }; }
    if ((m = TS_FUNCTION.exec(line))) { push(out, original, i, m[2]!, "function", 0, !!m[1]); return null; }
    if ((m = TS_ENUM.exec(line))) { push(out, original, i, m[2]!, "enum", 0, !!m[1]); return null; }
    if ((m = TS_TYPE.exec(line))) { push(out, original, i, m[2]!, "type", 0, !!m[1]); return null; }
    if ((m = TS_CONST.exec(line))) {
      const kind: SymbolKind = TS_ARROWISH.test(m[3] ?? "") ? "function" : "const";
      push(out, original, i, m[2]!, kind, 0, !!m[1]);
    }
    return null;
  }
  if (language === "java") {
    if ((m = JAVA_TYPE.exec(line))) {
      const exported = /\bpublic\b/.test(m[1] ?? "");
      const kind: SymbolKind = m[2] === "interface" || m[2] === "@interface" ? "interface" : m[2] === "enum" ? "enum" : "class";
      push(out, original, i, m[3]!, kind, 0, exported);
      return { kind: kind === "interface" ? "interface" : "class", exported };
    }
    return null;
  }
  if (language === "go") {
    if ((m = GO_METHOD.exec(line))) { push(out, original, i, m[2]!, "method", 0, isUpper(m[2]!)); return null; }
    if ((m = GO_FUNC.exec(line))) { push(out, original, i, m[1]!, "function", 0, isUpper(m[1]!)); return null; }
    if ((m = GO_TYPE.exec(line))) {
      const kind: SymbolKind = m[2] === "struct" ? "struct" : m[2] === "interface" ? "interface" : "type";
      push(out, original, i, m[1]!, kind, 0, isUpper(m[1]!));
      return m[2] === "interface" ? { kind: "interface", exported: isUpper(m[1]!) } : null;
    }
    if ((m = GO_VALUE.exec(line))) push(out, original, i, m[1]!, "const", 0, isUpper(m[1]!));
    return null;
  }
  if (language === "rust") {
    if ((m = RS_IMPL.exec(line))) { push(out, original, i, m[1]!, "impl", 0, true); return { kind: "impl", exported: true }; }
    if ((m = RS_FN.exec(line))) { push(out, original, i, m[2]!, "function", 0, !!m[1]); return null; }
    if ((m = RS_ITEM.exec(line))) {
      const word = m[2]!;
      const kind: SymbolKind =
        word === "struct" || word === "union" ? "struct" : word === "enum" ? "enum" : word === "trait" ? "trait"
          : word === "type" ? "type" : word === "mod" ? "module" : "const";
      push(out, original, i, m[3]!, kind, 0, !!m[1]);
      return word === "trait" ? { kind: "trait", exported: !!m[1] } : null;
    }
  }
  return null;
}

function member(
  line: string,
  i: number,
  original: readonly string[],
  out: OutlineSymbol[],
  language: CodeLanguage,
  js: boolean,
  container: Container,
): Omit<Container, "bodyDepth"> | null {
  let m: RegExpExecArray | null;
  if (js && (container.kind === "class" || container.kind === "interface")) {
    m = TS_METHOD.exec(line) ?? TS_FIELD_FN.exec(line);
    if (!m) return null;
    const name = m[1]!;
    if (NOT_A_MEMBER.has(name)) return null;
    const hidden = name.startsWith("#") || name.startsWith("_") || /^\s*(?:private|protected)\b/.test(line);
    push(out, original, i, name, "method", 1, container.exported && !hidden);
    return null;
  }
  if (language === "java" && (container.kind === "class" || container.kind === "interface")) {
    if (JAVA_TYPE.test(line)) return null;
    m = JAVA_METHOD.exec(line);
    if (m && !NOT_A_MEMBER.has(m[2]!) && !/^\s*(?:return|new|throw|else)\b/.test(line) && !/=/.test(line.split("(")[0] ?? "")) {
      const exported = /\bpublic\b/.test(m[1] ?? "") || container.kind === "interface";
      push(out, original, i, m[2]!, "method", 1, container.exported && exported);
    }
    return null;
  }
  if (language === "go" && container.kind === "interface") {
    if ((m = GO_IFACE_METHOD.exec(line))) push(out, original, i, m[1]!, "method", 1, isUpper(m[1]!));
    return null;
  }
  if (language === "rust" && (container.kind === "impl" || container.kind === "trait")) {
    if ((m = RS_FN.exec(line))) {
      push(out, original, i, m[2]!, "method", 1, container.kind === "trait" ? container.exported : !!m[1]);
    }
  }
  return null;
}

// ── Python ───────────────────────────────────────────────────────────────
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PY_CONST = /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=(?!=)/;

function outlinePython(lines: readonly string[], original: readonly string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  let cls: { indent: number; bodyIndent: number | null; exported: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (cls && indent <= cls.indent) cls = null;
    let m: RegExpExecArray | null;
    if (indent === 0) {
      if ((m = PY_CLASS.exec(line))) {
        push(out, original, i, m[2]!, "class", 0, !m[2]!.startsWith("_"));
        cls = { indent: 0, bodyIndent: null, exported: !m[2]!.startsWith("_") };
      } else if ((m = PY_DEF.exec(line))) {
        push(out, original, i, m[2]!, "function", 0, !m[2]!.startsWith("_"));
      } else if ((m = PY_CONST.exec(line))) {
        push(out, original, i, m[1]!, "const", 0, true);
      }
      continue;
    }
    if (!cls) continue;
    if (cls.bodyIndent === null) cls.bodyIndent = indent;
    if (indent !== cls.bodyIndent) continue;
    if ((m = PY_DEF.exec(line))) {
      const name = m[2]!;
      const dunder = name.startsWith("__") && name.endsWith("__");
      push(out, original, i, name, "method", 1, cls.exported && (dunder || !name.startsWith("_")));
    }
  }
  return out;
}
