/**
 * Glob-to-regex compilation for `os.fs.glob`, kept apart from the walk so
 * the tool file stays about traversal and its limits.
 */

export function matchesAny(matchers: RegExp[], path: string): boolean {
  for (const m of matchers) {
    if (m.test(path)) return true;
  }
  return false;
}

/**
 * Compile a glob pattern into a regex anchored at both ends. Pass `flags="i"`
 * for case-insensitive matching (used when `nocase=true` on the tool args).
 * Supports:
 *   - `*`     any chars except `/`
 *   - `**`    any number of path segments (including zero)
 *   - `?`     exactly one char except `/`
 *   - `{a,b}` alternation (one level, no nesting)
 *   - backslash-escaped literals
 *
 * Everything else is treated as a literal, with regex metachars escaped.
 */
export function compileGlob(pattern: string, flags = ""): RegExp {
  let re = "^";
  const len = pattern.length;
  let i = 0;
  while (i < len) {
    const c = pattern[i] as string;
    if (c === "\\" && i + 1 < len) {
      re += escapeRegexChar(pattern[i + 1] as string);
      i += 2;
      continue;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const prevIsBoundary = i === 0 || pattern[i - 1] === "/";
        const nextChar = pattern[i + 2];
        if (prevIsBoundary && nextChar === "/") {
          // `**/` — zero or more path segments.
          re += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        if (prevIsBoundary && nextChar === undefined) {
          re += ".*";
          i += 2;
          continue;
        }
        // Fallback: `**` in the middle of a segment behaves like `.*`.
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "{") {
      const end = findMatchingBrace(pattern, i);
      if (end !== -1) {
        const inner = pattern.slice(i + 1, end);
        const parts = splitBraceAlternatives(inner).map((alt) =>
          alt
            .split("")
            .map((ch) => escapeRegexChar(ch))
            .join(""),
        );
        re += "(?:" + parts.join("|") + ")";
        i = end + 1;
        continue;
      }
      re += "\\{";
      i++;
      continue;
    }
    re += escapeRegexChar(c);
    i++;
  }
  re += "$";
  return new RegExp(re, flags);
}

function escapeRegexChar(c: string): string {
  if (/[.+^$|()\\\[\]]/.test(c)) return "\\" + c;
  return c;
}

function findMatchingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}
