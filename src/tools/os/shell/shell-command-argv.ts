import {
  programName,
  splitCommandSegments,
} from "../shell-command-guard/command-segments.js";

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

/** Programs that run the command after them; a deny rule looks past them. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `FOO=1 env -i sudo npm publish` → `npm publish`. */
function withoutWrappers(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (ENV_ASSIGNMENT_RE.test(word)) i += 1;
    else if (COMMAND_WRAPPERS.has(programName(word))) {
      i += 1;
      while (i < words.length && words[i]!.startsWith("-")) i += 1;
    } else break;
  }
  return words.slice(i);
}

/**
 * Every simple command a call would run, for saved deny and ask rules
 * (`ApprovalRequest.commandSegments`). Unlike `shellCommandArgv` this is
 * never withheld: a rule that only tightens is safe to apply on a best
 * reading of the line. A wrapped command is listed both ways, so a rule
 * on `sudo` and a rule on what it runs both match.
 */
export function shellRuleSegments(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
): string[][] {
  const segments = useShell
    ? splitCommandSegments([cmd, ...execArgs].join(" "))
    : [[cmd, ...execArgs]];
  return segments.flatMap((words) => {
    const inner = withoutWrappers(words);
    return inner.length > 0 && inner.length < words.length ? [words, inner] : [words];
  });
}
