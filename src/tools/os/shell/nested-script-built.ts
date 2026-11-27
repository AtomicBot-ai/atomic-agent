import { PREFIX_COMMANDS, programName, splitCommandSegments } from "../shell-command-guard/command-segments.js";

/**
 * Whether the script of a `sh -c` / `bash -lc` is built at run time, so
 * no rule can read which programs it runs (ATO-2528). A command
 * substitution (`$(…)`, a backtick) or xargs' `{}` anywhere builds code.
 * A variable builds code only where a program goes: the whole script
 * (`bash -c "$CMD"`), a command word (`sh -c '$RUN --fast'`, `cd x &&
 * "$TOOL"`, past `sudo` / `env` / `xargs` and `A=1`), or an argument of
 * `eval`, `source` / `.` or `exec`. A variable in an argument (`sh -c
 * 'cd "$DIR" && make'`, `echo $HOME`) only changes that argument: the
 * programs stay readable, and the argument rules and the egress scan read
 * the nested line on their own (a `curl $URL` there is still an unknown
 * address). Before this, any `$` made the call unreadable, which counts
 * as sending data to an unknown host, so it asked at every level.
 */
const SUBSTITUTION_RE = /\$\(|`|\{\}/;
const VARIABLE_RE = /\$\{?[A-Za-z_0-9@*#?!-]/;
const RUNS_ITS_ARGUMENTS = new Set(["eval", "source", ".", "exec"]);
/** Words before a command that are not its program (`do $X`, `if ! $CHECK`). */
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "(", "time"]);

/** The index of the program word of `words`, past assignments and wrappers. */
function programIndex(words: readonly string[]): number {
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || SHELL_KEYWORDS.has(word)) {
      at += 1;
      continue;
    }
    if (VARIABLE_RE.test(word)) return at;
    const valueFlags = PREFIX_COMMANDS[programName(word)];
    if (valueFlags === undefined) return at;
    at += 1;
    while (at < words.length && words[at]!.startsWith("-")) {
      at += valueFlags.includes(words[at]!) ? 2 : 1;
    }
  }
  return at;
}

export function nestedScriptBuiltAtRunTime(script: string): boolean {
  if (SUBSTITUTION_RE.test(script)) return true;
  if (!VARIABLE_RE.test(script)) return false;
  for (const words of splitCommandSegments(script)) {
    const at = programIndex(words);
    const head = words[at];
    if (head === undefined) continue;
    if (VARIABLE_RE.test(head)) return true;
    if (RUNS_ITS_ARGUMENTS.has(programName(head)) && words.slice(at + 1).some((w) => VARIABLE_RE.test(w))) {
      return true;
    }
  }
  return false;
}
