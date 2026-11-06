/**
 * Characters after which a whitespace split of a subshell line is no
 * longer the argv the shell will run: quotes, escapes, globs, `~` and
 * comments. `shellGrantShape` already withholds a shape from lines that
 * sequence, pipe, redirect or substitute.
 */
const SUBSHELL_WORD_CHANGING_RE = /["'\\*?[\]~#!]/;

/**
 * The argv a saved approval rule's `commandPrefix` matches
 * (`ApprovalRequest.commandArgv`), or undefined when there is none to
 * trust.
 *
 * Only where the call has a grant shape (`shellGrantShape`): a simple
 * command whose binary is all that runs. A direct exec passes its argv
 * as is; a subshell line counts only when splitting it on whitespace is
 * exactly what the shell would do with it.
 */
export function shellCommandArgv(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  commandShape: string | undefined,
): string[] | undefined {
  if (commandShape === undefined) return undefined;
  if (!useShell) return [cmd, ...execArgs];
  const line = [cmd, ...execArgs].join(" ");
  if (SUBSHELL_WORD_CHANGING_RE.test(line)) return undefined;
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length > 0 ? tokens : undefined;
}
