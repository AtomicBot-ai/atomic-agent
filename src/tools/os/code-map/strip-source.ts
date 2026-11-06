import type { CodeLanguage } from "./outline-types.js";

/**
 * Blank out comments and the insides of string literals, keeping every
 * newline, so a line-based scan can count braces and match declarations
 * without being fooled by `"{"` or `// class Foo`. Quotes stay in place
 * (an emptied `"..."` is still a string to the eye); everything between
 * them becomes spaces.
 *
 * It is a heuristic, not a lexer: nested template expressions and Rust
 * raw strings with hashes are approximations. JS/TS regex literals are
 * blanked like strings when the `/` stands where an expression starts
 * (after `( , = : [ ! & | ? { } ;`, a keyword such as `return`, or at the
 * start of a line), so a `/[{]/` does not open a brace for the rest of
 * the file; a `/` anywhere else is division. The
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
    if (ch === "/" && js && regexAllowedAfter(out)) {
      const end = regexLiteralEnd(src, i);
      if (end > 0) {
        out.push("/");
        for (let k = i + 1; k < end - 1; k++) out.push(" ");
        out.push("/");
        i = end;
        while (i < n && /[a-z]/i.test(src[i]!)) { out.push(src[i]!); i++; }
        continue;
      }
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

/** Characters after which a `/` opens a regex literal, not a division. */
const REGEX_PREFIX_CHARS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);
/** Keywords after which a `/` opens a regex literal. */
const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "yield", "await", "throw", "void", "delete", "in", "of", "instanceof", "new", "else", "do"]);

/**
 * Whether the stripped text so far ends where an expression may start:
 * nothing but blanks back to a line start (or the file start), one of
 * `REGEX_PREFIX_CHARS`, or one of `REGEX_PREFIX_WORDS`.
 */
function regexAllowedAfter(out: readonly string[]): boolean {
  let word = "";
  for (let c = out.length - 1; c >= 0; c--) {
    const chunk = out[c]!;
    for (let k = chunk.length - 1; k >= 0; k--) {
      const ch = chunk[k]!;
      if (/[A-Za-z0-9_$]/.test(ch)) { word = ch + word; continue; }
      if (word) return REGEX_PREFIX_WORDS.has(word);
      if (ch === "\n") return true;
      if (ch === " " || ch === "\t" || ch === "\r") continue;
      return REGEX_PREFIX_CHARS.has(ch);
    }
  }
  return word ? REGEX_PREFIX_WORDS.has(word) : true;
}

/**
 * The index just past the closing `/` of a regex literal opening at
 * `start`, honouring escapes and `[...]` classes (a `/` inside a class
 * does not close it), or -1 when the line ends first: then it was not a
 * regex after all and the `/` is kept as it is.
 */
function regexLiteralEnd(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") { i++; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "/") return i === start + 1 ? -1 : i + 1;
  }
  return -1;
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
