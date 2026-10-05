import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { expandHome, resolveUserPath } from "../expand-home.js";
import { basenameCommand } from "./normalise.js";
import {
  lexShellLine,
  type ShellDialect,
  type ShellWord,
} from "./shell-line-lexer.js";

/**
 * The files a shell command line would change, as far as its words say:
 * redirect targets (`> f`, `>> f`, `2> f`, `&> f`, `tee f`), what a
 * remove/create/move command names (`rm`, `touch`, `truncate`, `mv`, …),
 * the destination of a copy (`cp a f`, `ln`, `rsync`, …), an in-place
 * `sed -i` / `perl -i`, and `dd of=f`. A nested `sh -c "<line>"` is read
 * as the line it runs, and `cd d &&` moves the directory the rest of the
 * line resolves against (not past the `)` of a `( … )` subshell).
 *
 * For the approval gate's same-turn rule (`ApprovalRequest.targetPaths`):
 * after the user declined a write of a file, a command that writes it by
 * another route is refused without asking again. A false refusal is the
 * worse mistake, so this names too little rather than too much: the line
 * is lexed as its shell would (`shell-line-lexer.ts`), so a quoted `"a|rm
 * b"` or `"<title>"` is one argument and a heredoc body is not a command;
 * a path built at runtime (`$(…)`, a glob, a variable other than `$HOME`)
 * or a write hidden inside an interpreter (`python -c "open(…)"`) is not
 * named; and a line the lexer cannot read names nothing at all. Either
 * way that command simply asks the user, as before. Windows verbs (`del`,
 * `move`, `Set-Content`, …) count only on Windows or inside a `cmd /c` /
 * PowerShell line.
 */
export function shellWriteTargets(commandLine: string, cwd: string): string[] {
  const windows = process.platform === "win32";
  const targets = lineTargets(commandLine, cwd, windows ? "cmd" : "posix", windows);
  return targets === null ? [] : unique(targets);
}

/**
 * `shellWriteTargets` for a direct exec (`spawn(cmd, args)`, no shell):
 * the argv is already split, so `>` or `;` inside an argument is text
 * and an argument with spaces is one word. Only a shell run with a
 * command line of its own (`sh -c "<line>"`, `cmd /c …`) has that line
 * read as one.
 */
export function execWriteTargets(
  cmd: string,
  args: readonly string[],
  cwd: string,
): string[] {
  const words = [cmd, ...args].map((text) => ({ text, dynamic: false }));
  const found = commandTargets(words, cwd, process.platform === "win32");
  return found === null ? [] : unique(found.targets);
}

/** Shells whose `-c` argument is itself a command line. */
const NESTED_SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

/** Words that run the command after them (`sudo rm f`, `env A=1 tee f`). */
const PREFIX_COMMANDS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "nohup",
  "nice",
  "time",
]);

/** Reserved words that open a command rather than name one (`then rm f`). */
const KEYWORDS: ReadonlySet<string> = new Set([
  "!",
  "{",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
]);

/** Commands every operand of which is a file they remove, create, empty or move. */
const CHANGES_EVERY_OPERAND: ReadonlySet<string> = new Set([
  "rm",
  "unlink",
  "rmdir",
  "shred",
  "trash",
  "touch",
  "truncate",
  "mv",
  "tee",
]);

/** Commands whose last operand is the file they write (`cp src dest`). */
const CHANGES_LAST_OPERAND: ReadonlySet<string> = new Set([
  "cp",
  "ln",
  "rsync",
  "ditto",
]);

/** Copy and move commands where `-t dir` names the destination up front. */
const TARGET_DIRECTORY_FLAG: ReadonlySet<string> = new Set(["cp", "mv", "ln"]);

/**
 * Flags whose value is the next word, per command, so the value is not
 * read as a file (`touch -r ref f` changes `f`, not `ref`).
 */
const VALUE_FLAGS: Readonly<Record<string, (flag: string) => boolean>> = {
  touch: (f) => ["-t", "-d", "-r", "--date", "--reference"].includes(f),
  truncate: (f) => ["-s", "-r", "--size", "--reference"].includes(f),
  shred: (f) => ["-n", "-s", "--iterations", "--size"].includes(f),
  cp: (f) => f === "-S" || f === "--suffix",
  mv: (f) => f === "-S" || f === "--suffix",
  ln: (f) => f === "-S" || f === "--suffix",
  rsync: (f) =>
    ["-e", "--rsh", "-f", "--filter", "--exclude", "--include"].includes(f),
  sed: (f) =>
    /^-[nErsuz]*[ef]$/.test(f) || ["-l", "--expression", "--file"].includes(f),
  perl: (f) => /^-[a-zA-Z0-9]*[eE]$/.test(f),
};

/** cmd.exe verbs every operand of which is a file they remove or move. */
const CMD_CHANGES_EVERY_OPERAND: ReadonlySet<string> = new Set([
  "del",
  "erase",
  "rd",
  "move",
  "ren",
  "rename",
]);

/**
 * PowerShell cmdlets: the parameters that name the file they change, and
 * which of the leading positional arguments do (`Move-Item a b`).
 */
const POWERSHELL_TARGETS: Readonly<
  Record<string, { named: readonly string[]; positional: readonly number[] }>
> = {
  "remove-item": { named: ["-path", "-literalpath"], positional: [0] },
  "new-item": { named: ["-path"], positional: [0] },
  "set-content": { named: ["-path", "-literalpath"], positional: [0] },
  "add-content": { named: ["-path", "-literalpath"], positional: [0] },
  "clear-content": { named: ["-path", "-literalpath"], positional: [0] },
  "out-file": { named: ["-filepath", "-literalpath", "-path"], positional: [0] },
  "move-item": {
    named: ["-path", "-literalpath", "-destination"],
    positional: [0, 1],
  },
  "copy-item": { named: ["-destination"], positional: [1] },
};

/**
 * The targets of a whole command line, or `null` when it cannot be read.
 * `dir` is where relative paths resolve; `undefined` once a `cd` went
 * somewhere this cannot know (`cd -`, `cd "$X"`), after which only
 * absolute paths are named.
 */
function lineTargets(
  line: string,
  dir: string | undefined,
  dialect: ShellDialect,
  windows: boolean,
): string[] | null {
  const tokens = lexShellLine(line, dialect);
  if (tokens === null) return null;
  const targets: string[] = [];
  // A `( … )` subshell's `cd` ends at its `)`.
  const outer: (string | undefined)[] = [];
  let cwd = dir;
  let words: ShellWord[] = [];
  const flush = (): boolean => {
    if (words.length === 0) return true;
    const found = commandTargets(words, cwd, windows);
    words = [];
    if (found === null) return false;
    targets.push(...found.targets);
    cwd = found.dir;
    return true;
  };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (token.kind === "word") {
      words.push(token);
      continue;
    }
    if (token.kind === "redirect") {
      const next = tokens[k + 1];
      if (next?.kind !== "word") return null;
      k += 1;
      const isFile =
        token.writes === "file" ||
        (token.writes === "dup" && !/^(?:\d+|-)$/.test(next.text));
      const target = isFile ? resolveWord(next, cwd) : undefined;
      if (target !== undefined) targets.push(target);
      continue;
    }
    if (!flush()) return null;
    if (token.kind === "open") outer.push(cwd);
    else if (token.kind === "close" && outer.length > 0) cwd = outer.pop();
  }
  if (!flush()) return null;
  return targets;
}

/**
 * What one simple command changes, past assignments, prefix commands
 * and reserved words, and the directory the line goes on in: a `cd`
 * moves it, anything else leaves it. A nested shell's line is read as
 * its own (its `cd` stays inside it); `null` when that line cannot be.
 */
function commandTargets(
  words: readonly ShellWord[],
  dir: string | undefined,
  windows: boolean,
): { targets: string[]; dir: string | undefined } | null {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!.text;
    if (KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    if (!PREFIX_COMMANDS.has(commandName(word))) break;
    i += 1;
    while (i < words.length && words[i]!.text.startsWith("-")) i += 1;
  }
  const head = words[i];
  const none = { targets: [], dir };
  if (head === undefined || head.dynamic) return none;
  const name = commandName(head.text);
  const args = words.slice(i + 1);

  if (name === "cd" || name === "pushd") {
    const operands = windows ? cmdOperands(args) : plainOperands(args);
    const to = operands[0];
    if (to === undefined) return { targets: [], dir: homedir() };
    return { targets: [], dir: to.text === "-" ? undefined : resolveWord(to, dir) };
  }
  if (name === "popd") return { targets: [], dir: undefined };

  const nested = nestedLine(name, args);
  if (nested !== undefined) {
    if (nested === null) return none;
    // Its own `cd` stays inside it; a cmd.exe or PowerShell line speaks
    // Windows verbs wherever it runs.
    const targets = lineTargets(
      nested.line,
      dir,
      nested.dialect,
      windows || nested.dialect !== "posix",
    );
    return targets === null ? null : { targets, dir };
  }

  const targets: string[] = [];
  for (const word of changedWords(name, args, windows)) {
    const target = resolveWord(word, dir);
    if (target !== undefined) targets.push(target);
  }
  return { targets, dir };
}

/**
 * The command line a shell is told to run (`sh -c "<line>"`,
 * `cmd /c del f`, `pwsh -Command …`), `null` for a shell running a
 * script file or a line built at runtime, `undefined` for a command that
 * is not a shell.
 */
function nestedLine(
  name: string,
  args: readonly ShellWord[],
): { line: string; dialect: ShellDialect } | null | undefined {
  if (NESTED_SHELLS.has(name)) {
    for (let j = 0; j < args.length; j++) {
      const flag = args[j]!.text;
      if (!/^[-+]/.test(flag)) return null;
      if (/^[-+][oO]$/.test(flag)) {
        j += 1;
        continue;
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag)) {
        const script = args[j + 1];
        return script === undefined || script.dynamic
          ? null
          : { line: script.text, dialect: "posix" };
      }
    }
    return null;
  }
  if (name === "cmd") {
    const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg.text));
    return at === -1 ? null : { line: joinWords(args.slice(at + 1)), dialect: "cmd" };
  }
  if (name === "powershell" || name === "pwsh") {
    const at = args.findIndex((arg) => /^-(?:c|command)$/i.test(arg.text));
    return at === -1
      ? null
      : { line: joinWords(args.slice(at + 1)), dialect: "powershell" };
  }
  return undefined;
}

/** The words of a command that name a file it changes. */
function changedWords(
  name: string,
  args: readonly ShellWord[],
  windows: boolean,
): ShellWord[] {
  const takesValue = VALUE_FLAGS[name];
  if (
    TARGET_DIRECTORY_FLAG.has(name) &&
    args.some(
      (arg) =>
        /^-[a-zA-Z]*t/.test(arg.text) ||
        arg.text.startsWith("--target-directory"),
    )
  ) {
    // `cp -t dir a b`: what lands in `dir` is not spelled out.
    return [];
  }
  if (CHANGES_EVERY_OPERAND.has(name)) return plainOperands(args, takesValue);
  if (CHANGES_LAST_OPERAND.has(name)) {
    const operands = plainOperands(args, takesValue);
    return operands.length > 1 ? operands.slice(-1) : [];
  }
  if (name === "sed" || name === "perl") return inPlaceFiles(name, args);
  if (name === "dd") {
    return args
      .filter((arg) => arg.text.startsWith("of="))
      .map((arg) => ({ ...arg, text: arg.text.slice("of=".length) }));
  }
  if (!windows) return [];
  if (CMD_CHANGES_EVERY_OPERAND.has(name)) return cmdOperands(args);
  if (name === "copy") {
    const operands = cmdOperands(args);
    return operands.length > 1 ? operands.slice(-1) : [];
  }
  const cmdlet = POWERSHELL_TARGETS[name];
  return cmdlet === undefined ? [] : powershellTargets(args, cmdlet);
}

/**
 * The files `sed -i` / `perl -i` rewrite: its operands, less the script
 * when no `-e` / `-f` gave it. `-i` only in a flag cluster of options
 * that take no value (`-ni`, `-pi`), so `perl -Mstrict` is not one.
 */
function inPlaceFiles(name: "sed" | "perl", args: readonly ShellWord[]): ShellWord[] {
  const inPlace =
    name === "sed"
      ? args.some(
          (arg) => /^-[nErsuz]*i/.test(arg.text) || arg.text.startsWith("--in-place"),
        )
      : args.some((arg) => /^-[anplsw0-9]*i/.test(arg.text));
  if (!inPlace) return [];
  const takesValue = VALUE_FLAGS[name]!;
  const scriptGiven = args.some(
    (arg) => takesValue(arg.text) && !["-l"].includes(arg.text),
  );
  // `sed -i '' …` (BSD): the empty suffix is not a file.
  const operands = plainOperands(args, takesValue).filter((arg) => arg.text !== "");
  return scriptGiven ? operands : operands.slice(1);
}

/** Arguments that are not flags (or their values); after `--`, all are. */
function plainOperands(
  args: readonly ShellWord[],
  takesValue?: (flag: string) => boolean,
): ShellWord[] {
  const operands: ShellWord[] = [];
  let flagsDone = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    if (!flagsDone && arg.text === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && arg.text.startsWith("-") && arg.text.length > 1) {
      if (takesValue?.(arg.text) === true) k += 1;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

/** cmd.exe arguments that are not `/x` switches. */
function cmdOperands(args: readonly ShellWord[]): ShellWord[] {
  return args.filter((arg) => !/^\/[A-Za-z?](?::\S*)?$/.test(arg.text));
}

function powershellTargets(
  args: readonly ShellWord[],
  cmdlet: { named: readonly string[]; positional: readonly number[] },
): ShellWord[] {
  const leading: ShellWord[] = [];
  for (const arg of args) {
    if (arg.text.startsWith("-")) break;
    leading.push(arg);
  }
  const found = cmdlet.positional.flatMap((at) => leading[at] ?? []);
  for (let k = 0; k + 1 < args.length; k++) {
    if (cmdlet.named.includes(args[k]!.text.toLowerCase())) found.push(args[k + 1]!);
  }
  return found;
}

/** Basename, lowercased, without `.exe`: `rm`, `remove-item`, `cmd`. */
function commandName(word: string): string {
  return basenameCommand(word).toLowerCase().replace(/\.exe$/, "");
}

/**
 * The words after `/c` or `-Command` back into the line they spell: one
 * word is the line itself (`cmd /c "del a.txt"`); several are joined,
 * quoting the ones with spaces (`cmd /c del "my file.txt"`).
 */
function joinWords(words: readonly ShellWord[]): string {
  if (words.length === 1) return words[0]!.text;
  return words.map(({ text }) => (/\s/.test(text) ? `"${text}"` : text)).join(" ");
}

/**
 * A word as an absolute path, or `undefined` when it cannot be one: a
 * word only known at runtime, `-` (standard input or output), a device
 * (`/dev/null`, `NUL`), or a relative path after a `cd` this could not
 * follow.
 */
function resolveWord(word: ShellWord, dir: string | undefined): string | undefined {
  const text = word.text;
  if (word.dynamic || text.length === 0 || text === "-") return undefined;
  if (text.startsWith("/dev/") || /^nul$/i.test(text)) return undefined;
  if (dir === undefined && !isAbsolute(expandHome(text))) return undefined;
  try {
    return resolve(resolveUserPath(text, dir ?? homedir()));
  } catch {
    // A POSIX-absolute path on Windows: not a file this can name.
    return undefined;
  }
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
