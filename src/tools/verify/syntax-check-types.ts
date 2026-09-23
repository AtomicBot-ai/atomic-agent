/**
 * One file's verdict from `verify.syntax`.
 *
 * `ok` has three values on purpose. `true` and `false` are verdicts;
 * `null` is the absence of one — no checker for the extension, the
 * checker's binary is missing, or the checker could not judge the file
 * (an ES module under a plain-script parser). A file with no verdict is
 * reported as unchecked and never counts as passing: a green result over
 * a file nobody looked at is worse than no check at all.
 */
export interface SyntaxFileResult {
  /** The path as the caller gave it. */
  readonly file: string;
  readonly ok: boolean | null;
  /** The checker that produced the verdict, or `"none"`. */
  readonly checker: string;
  /** The failure, or why there is no verdict. */
  readonly error?: string;
  /** Advisory — never changes `ok` (content after `</html>`, say). */
  readonly warning?: string;
}

/** Longest error text kept per file; checkers are chatty, prompts are not. */
export const SYNTAX_ERROR_MAX_CHARS = 600;

/** The last non-blank lines of a checker's stderr, capped. */
export function tailOfOutput(text: string, lines = 5): string {
  const kept = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-lines)
    .join("\n");
  return kept.length > SYNTAX_ERROR_MAX_CHARS
    ? `…${kept.slice(-SYNTAX_ERROR_MAX_CHARS)}`
    : kept;
}
