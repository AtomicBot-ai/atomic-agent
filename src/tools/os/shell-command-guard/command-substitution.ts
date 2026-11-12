/**
 * The word a command substitution (`$(…)`, a backtick pair) stands for
 * once it is lifted out of a line. It reads
 * as a variable to the lexer, so the word is `dynamic` and a rule can
 * tell that its value is only known when the line runs.
 */
export const SUBSTITUTION_PLACEHOLDER = "$__computed__";

/**
 * The placeholder for a substitution whose body only prints text it
 * spells out (`$(echo -f)`, `$(printf -- --hard)`): its value can be
 * any flag the line chose, so it counts as a computed option wherever
 * it stands. Starts with the generic placeholder's text.
 */
export const PRINTED_PLACEHOLDER = "$__computed__printed__";

const PRINTS_LITERAL = /^\s*(?:echo|printf|print)\b/;

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
      const body = line.slice(i + 2, end);
      if (body.startsWith("(") && body.endsWith(")")) {
        // `$((1 + 2))` is arithmetic, not a command, but a substitution
        // inside it still runs: `$(( $(git push -f; echo 1) ))`.
        const nested = liftSubstitutions(body.slice(1, -1));
        if (nested === null) return null;
        inner.push(...nested.inner);
        outer += SUBSTITUTION_PLACEHOLDER;
      } else {
        inner.push(body);
        outer += PRINTS_LITERAL.test(body) ? PRINTED_PLACEHOLDER : SUBSTITUTION_PLACEHOLDER;
      }
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = closingBacktick(line, i + 1);
      if (end === -1) return null;
      const body = line.slice(i + 1, end).replace(/\\`/g, "`");
      inner.push(body);
      outer += PRINTS_LITERAL.test(body) ? PRINTED_PLACEHOLDER : SUBSTITUTION_PLACEHOLDER;
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
 * Whether any part of a word is only known when the line runs: a lifted
 * substitution or a variable anywhere in it (`$F`, `--$m`, `-${f}`,
 * `$1`). A `$` with nothing it could expand after it is a literal.
 */
export function isComputedWord(word: string): boolean {
  return /\$[A-Za-z_0-9@*#?!{(-]/.test(word);
}

/**
 * Whether a word may turn into an option when the line runs, so a git
 * rule cannot read what it does: a dash followed by something computed
 * (`--$m`, `-$f`), or a substitution that only prints the text the line
 * spelled out (`$(echo -f)`). A plain `$BRANCH` or `$(git rev-parse …)`
 * in an argument slot is left to the ordinary approval path: a variable
 * that holds a flag is not seen (ATO-1263 review).
 */
export function isComputedOption(word: string): boolean {
  if (word.includes(PRINTED_PLACEHOLDER)) return true;
  return word.startsWith("-") && isComputedWord(word);
}
