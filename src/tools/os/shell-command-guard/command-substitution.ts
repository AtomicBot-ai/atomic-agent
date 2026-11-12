/**
 * The word a command substitution (`$(…)`, a backtick pair) stands for
 * once it is lifted out of a line. It reads
 * as a variable to the lexer, so the word is `dynamic` and a rule can
 * tell that its value is only known when the line runs.
 */
export const SUBSTITUTION_PLACEHOLDER = "$__computed__";

export interface LiftedLine {
  /** The line with every substitution replaced by the placeholder. */
  outer: string;
  /** The command lines inside the substitutions, outermost first. */
  inner: string[];
}

/**
 * Take the command substitutions out of a POSIX line so the lexer can
 * read the rest: `git -C $(pwd) push --force` becomes `git -C
 * $__computed__ push --force` plus the inner line `pwd`. Without this
 * the lexer refuses the whole line and the plain fallback split loses
 * which words belong to which command (`push --force` ended up in a
 * segment of its own, with no `git` in front).
 *
 * Quotes are respected: inside single quotes nothing is a substitution;
 * inside double quotes `$(…)` and backticks still are. `${…}` is left
 * alone. Returns `null` when a substitution or a quote is not closed,
 * so the caller keeps its old fallback.
 */
export function liftSubstitutions(line: string): LiftedLine | null {
  if (!line.includes("$(") && !line.includes("`")) {
    return { outer: line, inner: [] };
  }
  const inner: string[] = [];
  let outer = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      outer += c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      outer += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = true;
      outer += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      outer += c;
      i += 1;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const end = matchingClose(line, i + 2, "(", ")");
      if (end === -1) return null;
      // `$((1 + 2))` is arithmetic, not a command; its body is dropped.
      const body = line.slice(i + 2, end);
      if (!(body.startsWith("(") && body.endsWith(")"))) inner.push(body);
      outer += SUBSTITUTION_PLACEHOLDER;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = closingBacktick(line, i + 1);
      if (end === -1) return null;
      inner.push(line.slice(i + 1, end).replace(/\\`/g, "`"));
      outer += SUBSTITUTION_PLACEHOLDER;
      i = end + 1;
      continue;
    }
    outer += c;
    i += 1;
  }
  if (inSingle || inDouble) return null;
  return { outer, inner };
}

/**
 * Index of the `close` that ends a group opened just before `from`,
 * counting nested `open`s and skipping quoted text. `-1` if none.
 */
function matchingClose(
  line: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  for (let i = from; i < line.length; i += 1) {
    const c = line[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inDouble) continue;
    if (c === open) depth += 1;
    if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function closingBacktick(line: string, from: number): number {
  for (let i = from; i < line.length; i += 1) {
    if (line[i] === "\\") {
      i += 1;
      continue;
    }
    if (line[i] === "`") return i;
  }
  return -1;
}

/**
 * Whether a word's value is only known when the line runs: a lifted
 * substitution or a variable (`$F`, `$1`). A lone `$` is a literal.
 */
export function isComputedWord(word: string): boolean {
  return /^\$[A-Za-z_0-9@*#?!{(-]/.test(word) || word.includes(SUBSTITUTION_PLACEHOLDER);
}
