/**
 * What a script only prints, taken out of the text the browser-bypass
 * rules read (ATO-1349, ATO-1353). A sign-in hint such as
 * `print("Open https://… and enter the code")` names a URL but opens
 * nothing; a real launch (`os.system("open …")`) is left in place.
 */

/**
 * Calls in a script that only print (ATO-1349, ATO-1353): Python `print`,
 * `sys.stdout.write`, `logging.*`, JavaScript `console.*` and
 * `process.stdout.write`. A sign-in hint such as
 * `print("Open https://… and enter the code")` is not a browser launch.
 */
const PRINT_CALL =
  /(?<![\w$])(?:print|pprint|sys\s*\.\s*(?:stdout|stderr)\s*\.\s*write|(?:logging|logger|log)\s*\.\s*(?:debug|info|warning|warn|error|critical|exception)|console\s*\.\s*(?:log|info|warn|error|debug)|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write)\s*\(/g;

/** Something that could run what a script prints; then its prints are read like any text. */
const OUTPUT_RUN_ON =
  /\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|osascript|python\d*(?:\.\d+)?|node|deno|bun|perl|ruby|php|xargs|eval|source|open|xdg-open)\b|\beval\b|\$\(|<\(/;

/**
 * The text with the string literals passed straight to a print-only call
 * emptied: `print("open https://x")` reads as `print("")`. Strings inside
 * a nested call (`print(os.system("open …"))`) and the code in an f-string
 * or template-literal interpolation are kept, as is the whole text when its
 * output could be run or a call cannot be read to its end.
 */
export function blankPrintedLiterals(text: string): string {
  if (OUTPUT_RUN_ON.test(text)) return text;
  let out = "";
  let from = 0;
  PRINT_CALL.lastIndex = 0;
  for (let m = PRINT_CALL.exec(text); m !== null; m = PRINT_CALL.exec(text)) {
    const open = m.index + m[0].length;
    const args = blankCallArgs(text, open);
    if (args === null) continue;
    out += text.slice(from, open) + args.text;
    from = args.end;
    PRINT_CALL.lastIndex = args.end;
  }
  return out + text.slice(from);
}

/** The arguments of a call from just after its `(` to its `)`, top-level literals emptied; `null` if unreadable. */
function blankCallArgs(text: string, start: number): { text: string; end: number } | null {
  let out = "";
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    const literal = readLiteral(text, i);
    if (literal === "unterminated") return null;
    if (literal !== null) {
      out += depth === 0 ? literal.blanked : text.slice(i, literal.end);
      i = literal.end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return c === ")" ? { text: `${out})`, end: i + 1 } : null;
      depth -= 1;
    } else if (c === ";" && depth === 0) return null;
    out += c;
    i += 1;
  }
  return null;
}

/**
 * A string literal starting at `i` (`'…'`, `"…"`, `` `…` ``, Python
 * triple quotes and `f`/`r`/`b` prefixes, or `\"…\"` escaped for the
 * shell around the script): where it ends, and the literal with only its
 * interpolated code left. `null` when no literal starts at `i`.
 */
function readLiteral(text: string, i: number): { end: number; blanked: string } | "unterminated" | null {
  let delim: string;
  const c = text[i]!;
  if (c === "\\" && (text[i + 1] === '"' || text[i + 1] === "'")) delim = c + text[i + 1]!;
  else if (c === '"' || c === "'") delim = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
  else if (c === "`") delim = c;
  else return null;
  const escapedForShell = delim.length === 2;
  const multiline = delim.length === 3 || delim === "`" || escapedForShell;
  const prefix = /(?:^|[^\w$])([rbuf]{1,2})$/.exec(text.slice(Math.max(0, i - 3), i))?.[1] ?? "";
  const pyFormat = prefix.includes("f");
  const template = delim === "`";
  let kept = "";
  let j = i + delim.length;
  while (j < text.length) {
    if (text.startsWith(delim, j)) return { end: j + delim.length, blanked: delim + kept + delim };
    const ch = text[j]!;
    if (ch === "\n" && !multiline) return "unterminated";
    if (ch === "\\" && !escapedForShell) {
      j += 2;
      continue;
    }
    const interpolation = (pyFormat && ch === "{" && text[j + 1] !== "{") || (template && ch === "$" && text[j + 1] === "{");
    if (pyFormat && ch === "{" && text[j + 1] === "{") {
      j += 2;
      continue;
    }
    if (interpolation) {
      const open = text.indexOf("{", j);
      let depth = 0;
      let k = open;
      for (; k < text.length; k++) {
        if (text[k] === "{") depth += 1;
        else if (text[k] === "}" && --depth === 0) break;
      }
      if (k >= text.length) return "unterminated";
      kept += text.slice(j, k + 1);
      j = k + 1;
      continue;
    }
    j += 1;
  }
  return "unterminated";
}
