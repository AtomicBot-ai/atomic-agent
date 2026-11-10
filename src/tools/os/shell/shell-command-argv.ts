import {
  invocationsOf,
  NESTED_SHELL_PROGRAMS,
  PREFIX_COMMANDS,
  programName,
  scanNestedShellOptions,
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

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The value-taking flags of a command that runs the command after it, or undefined. */
function prefixCommandFlags(name: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(PREFIX_COMMANDS, name)
    ? PREFIX_COMMANDS[name]
    : undefined;
}

/**
 * `FOO=1 env -u X sudo -u root nice -n 5 timeout 10 npm publish` →
 * `npm publish`. Each wrapper's value-taking flags (`PREFIX_COMMANDS`,
 * shared with the guard's browser-bypass layer) skip their value too, so
 * `sudo -u root rm` reads as `rm`, not `root`.
 */
function withoutWrappers(input: readonly string[]): string[] {
  const words = [...input];
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (ENV_ASSIGNMENT_RE.test(word)) {
      i += 1;
      continue;
    }
    const name = programName(word);
    const valueFlags = prefixCommandFlags(name);
    if (valueFlags === undefined) break;
    i += 1;
    while (i < words.length) {
      const next = words[i]!;
      if (name === "env" && ENV_ASSIGNMENT_RE.test(next)) {
        i += 1;
        continue;
      }
      // `env -S 'rm -rf x'`: the value is the command line, split on blanks.
      if (name === "env" && (next === "-S" || next === "--split-string")) {
        const split = (words[i + 1] ?? "").split(/\s+/).filter((t) => t.length > 0);
        words.splice(i, 2, ...split);
        break;
      }
      if (next === "--") {
        i += 1;
        break;
      }
      if (!next.startsWith("-")) break;
      i += valueFlags.includes(next) ? 2 : 1;
    }
    // `timeout 5 cmd`: the duration comes first.
    if ((name === "timeout" || name === "gtimeout") && /^\d/.test(words[i] ?? "")) i += 1;
  }
  return words.slice(i);
}

/**
 * How many `bash -c` levels deep a deny rule still looks. A real line
 * nests one or two; the bound only stops a pathological input.
 */
const MAX_NESTED_SHELL_DEPTH = 4;

/**
 * Every simple command a call would run, for saved deny and ask rules
 * (`ApprovalRequest.commandSegments`). Unlike `shellCommandArgv` this is
 * never withheld: a rule that only tightens is safe to apply on a best
 * reading of the line. A wrapped command is listed both ways, so a rule
 * on `sudo` and a rule on what it runs both match. The line a nested
 * shell runs (`bash -c "rm -rf x"`, `sh -lc 'cd x && rm y'`), what
 * `eval` runs and what `find -exec` runs are split the same way and
 * listed after the command itself (ATO-1332).
 */
export function shellRuleSegments(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
): string[][] {
  const segments = useShell
    ? splitCommandSegments([cmd, ...execArgs].join(" "))
    : [[cmd, ...execArgs]];
  return segments.flatMap((words) => expandSegment(words, 0));
}

function expandSegment(words: string[], depth: number): string[][] {
  const inner = withoutWrappers(words);
  const unwrapped = inner.length > 0 && inner.join("\0") !== words.join("\0");
  const listed = unwrapped ? [words, inner] : [words];
  if (depth >= MAX_NESTED_SHELL_DEPTH) return listed;
  const lines = nestedShellScripts(words);
  // `eval rm -rf x`: eval joins its words and runs them as a line.
  if (inner.length > 1 && programName(inner[0]!) === "eval") {
    lines.push(inner.slice(1).join(" "));
  }
  const nested = lines.flatMap((line) =>
    splitCommandSegments(line).flatMap((w) => expandSegment(w, depth + 1)),
  );
  const executed = findExecCommands(inner).flatMap((w) => expandSegment(w, depth + 1));
  return [...listed, ...nested, ...executed];
}

/**
 * The command lines nested shells in `words` run: `bash -c <line>`
 * anywhere in the segment, so `sudo bash -c`, `nice -n 5 sh -c` and
 * `xargs sh -c` are read too, the way the guard's dangerous layer finds
 * them.
 */
function nestedShellScripts(words: readonly string[]): string[] {
  const scripts: string[] = [];
  for (const program of NESTED_SHELL_PROGRAMS) {
    for (const args of invocationsOf([words], program)) {
      for (const script of scanNestedShellOptions(args, program).scripts) {
        if (script.trim() !== "") scripts.push(script);
      }
    }
  }
  return scripts;
}

/** `find . -exec rm {} \;`: the words after each `-exec` are a command. */
function findExecCommands(words: readonly string[]): string[][] {
  if (words.length === 0 || programName(words[0]!) !== "find") return [];
  const commands: string[][] = [];
  for (let i = 1; i < words.length; i += 1) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[i]!)) continue;
    const end = words.findIndex((w, k) => k > i && (w === ";" || w === "+"));
    const command = words.slice(i + 1, end === -1 ? undefined : end);
    if (command.length > 0) commands.push(command);
    if (end === -1) break;
    i = end;
  }
  return commands;
}

/** Interpreters that, with no script of their own, run what comes on stdin. */
const STDIN_INTERPRETER_RE = /^(?:python\d*(?:\.\d+)?|node|ruby|perl|php|osascript)$/;
/** `python3 -c`, `-m`, `node -e` / `-p`, `perl -E`, `php -r`: the code is on the line. */
const INLINE_CODE_FLAG_RE = /^-[A-Za-z]*[cemrEp]$|^--(?:eval|print)(?:=|$)/;

/** Whether this command runs a script read from stdin rather than one on the line. */
function readsScriptFromStdin(words: readonly string[]): boolean {
  const head = words[0];
  if (head === undefined) return false;
  const name = programName(head);
  const args = words.slice(1);
  if (NESTED_SHELL_PROGRAMS.includes(name)) {
    return scanNestedShellOptions(args, name).readsStdin;
  }
  if (!STDIN_INTERPRETER_RE.test(name)) return false;
  if (args.some((a) => INLINE_CODE_FLAG_RE.test(a))) return false;
  const operand = args.find((a) => a === "-" || !a.startsWith("-"));
  return operand === undefined || operand === "-";
}

/**
 * Whether the call runs a script no rule can read
 * (`ApprovalRequest.commandUnreadable`): a shell or an interpreter with
 * no script of its own, on a subshell line that feeds it through a pipe,
 * a redirect or a heredoc (`printf 'rm -rf x' | sh`, `sh < run.sh`,
 * `curl … | python3`). The command has no stdin otherwise, so a bare
 * `sh` run directly is not one.
 */
export function shellRunsUnreadableScript(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
): boolean {
  if (!useShell) return false;
  if (!/[|<]/.test([cmd, ...execArgs].join(" "))) return false;
  return shellRuleSegments(cmd, execArgs, useShell).some(readsScriptFromStdin);
}
