import type { CodeLanguage } from "./outline-types.js";

/**
 * Blank out comments and the insides of string literals, keeping every
 * newline, so a line-based scan can count braces and match declarations
 * without being fooled by `"{"` or `// class Foo`. Quotes stay in place
 * (an emptied `"..."` is still a string to the eye); everything between
 * them becomes spaces.
 *
 * It is a heuristic, not a lexer: regex literals, nested template
 * expressions and Rust raw strings with hashes are approximations. The
 * cost of a miss is one wrong brace count for the rest of that file,
 * which the outline survives (it only decides what counts as a member).
 */
export function stripSource(source: string, language: CodeLanguage): string {
  return language === "python" ? stripPython(source) : stripCLike(source, language);
}

function blank(ch: string): string {
  return ch === "\n" ? "\n" : " ";
}

function stripCLike(src: string, language: CodeLanguage): string {
  const out: string[] = [];
  const js = language === "typescript" || language === "tsx" || language === "javascript";
  const rust = language === "rust";
  const go = language === "go";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") { out.push(" "); i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push("  "); i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out.push(blank(src[i]!)); i++; }
      if (i < n) { out.push("  "); i += 2; }
      continue;
    }
    // Rust lifetimes (`'a`) are not strings: only `'x'` / `'\n'` are chars.
    if (ch === "'" && rust) {
      const m = /^'(?:\\.|[^\\'\n])'/.exec(src.slice(i, i + 12));
      if (m) { out.push("'", " ".repeat(m[0].length - 2), "'"); i += m[0].length; continue; }
      out.push(ch); i++;
      continue;
    }
    const multiline = (js && ch === "`") || (go && ch === "`");
    if (ch === '"' || ch === "'" || multiline) {
      const quote = ch;
      out.push(quote); i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && !(go && quote === "`")) { out.push(" "); i++; if (i < n) { out.push(blank(src[i]!)); i++; } continue; }
        if (src[i] === "\n" && !multiline) break; // unterminated: stop at end of line
        out.push(blank(src[i]!)); i++;
      }
      if (i < n && src[i] === quote) { out.push(quote); i++; }
      continue;
    }
    out.push(ch); i++;
  }
  return out.join("");
}

function stripPython(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === "#") {
      while (i < n && src[i] !== "\n") { out.push(" "); i++; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = src.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      out.push(quote); i += quote.length;
      while (i < n && !src.startsWith(quote, i)) {
        if (src[i] === "\\") { out.push(" "); i++; if (i < n) { out.push(blank(src[i]!)); i++; } continue; }
        if (src[i] === "\n" && !triple) break;
        out.push(blank(src[i]!)); i++;
      }
      if (i < n && src.startsWith(quote, i)) { out.push(quote); i += quote.length; }
      continue;
    }
    out.push(ch); i++;
  }
  return out.join("");
}
