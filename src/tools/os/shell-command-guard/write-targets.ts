import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveUserPath } from "../expand-home.js";
import { basenameCommand } from "./normalise.js";

/**
 * The files a shell command line would change, as far as its words say:
 * redirect targets (`> f`, `>> f`, `2> f`, `&> f`, `tee f`), what a
 * remove/create/move command names (`rm`, `touch`, `truncate`, `mv`, …),
 * the destination of a copy (`cp a f`, `ln`, `rsync`, …), an in-place
 * `sed -i` / `perl -i`, and `dd of=f`. A nested `sh -c "<line>"` is read
 * as the line it runs, and `cd d &&` moves the directory the rest of the
 * line resolves against.
 *
 * For the approval gate's same-turn rule (`ApprovalRequest.targetPaths`):
 * after the user declined a write of a file, a command that writes it by
 * another route is refused without asking again. So this errs towards
 * naming too little — a path built at runtime (`$(…)`, a glob, a variable
 * other than `$HOME`) or a write hidden inside an interpreter
 * (`python -c "open(…)"`) is not named, and that command simply asks the
 * user as before. Works on the same whitespace tokens the guard reads
 * in subshell mode, with quotes taken off.
 */
export function shellWriteTargets(commandLine: string, cwd: string): string[] {
  const targets = new Set<string>();
  let dir = cwd;
  for (const words of simpleCommands(commandLine)) {
    const { operands, redirects } = splitRedirects(words);
    const command = commandOf(operands);
    if (command?.name === "cd") {
      const to = firstOperand(command.args);
      const next = to === undefined ? undefined : resolveTarget(to, dir);
      if (next !== undefined) dir = next;
      continue;
    }
    const named = command === null ? [] : changedOperands(command);
    for (const word of [...redirects, ...named]) {
      const target = resolveTarget(word, dir);
      if (target !== undefined) targets.add(target);
    }
  }
  return [...targets];
}

/** Words that end one simple command and start the next. */
const SEPARATORS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"]);

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
  // Windows (cmd.exe and PowerShell).
  "del",
  "erase",
  "rd",
  "move",
  "ren",
  "rename",
  "remove-item",
  "move-item",
  "new-item",
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
]);

/** Commands whose last operand is the file they write (`cp src dest`). */
const CHANGES_LAST_OPERAND: ReadonlySet<string> = new Set([
  "cp",
  "install",
  "ln",
  "rsync",
  "ditto",
  "copy",
  "copy-item",
]);

/** Commands that rewrite their file operands with an `-i` flag. */
const IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl"]);

/**
 * The line split into simple commands, each a list of words with quotes
 * and grouping brackets taken off. Operators glued to a word
 * (`a;rm f`, `x&&y`) are split out first; `>|` stays a redirect.
 */
function simpleCommands(commandLine: string): string[][] {
  const spaced = commandLine.replace(/&&|\|\||[;\n]|(?<![>|])\|(?!\|)/g, (op) =>
    op === "\n" ? " ; " : ` ${op} `,
  );
  const commands: string[][] = [[]];
  for (const raw of spaced.split(/\s+/)) {
    const word = raw
      .replace(/["']/g, "")
      .replace(/^(?:\$\(|[({`])+/, "")
      .replace(/[)}`]+$/, "");
    if (word.length === 0) continue;
    if (SEPARATORS.has(word)) {
      commands.push([]);
      continue;
    }
    commands[commands.length - 1]!.push(word);
  }
  return commands.filter((words) => words.length > 0);
}

/**
 * Separate redirect targets from the other words. `2>&1` and `>&2` name
 * a descriptor, not a file; `->` and `=>` are text (an arrow being
 * echoed), not a redirect.
 */
function splitRedirects(words: readonly string[]): {
  operands: string[];
  redirects: string[];
} {
  const operands: string[] = [];
  const redirects: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const at = word.indexOf(">");
    if (at === -1 || /[-=]$/.test(word.slice(0, at))) {
      operands.push(word);
      continue;
    }
    const head = word.slice(0, at).replace(/(?:\d+|&)$/, "");
    if (head.length > 0) operands.push(head);
    let target = word.slice(at + 1).replace(/^>?\|?/, "");
    if (target.length === 0) {
      target = words[i + 1] ?? "";
      i += 1;
    }
    if (target.length > 0 && !target.startsWith("&")) redirects.push(target);
  }
  return { operands, redirects };
}

interface SimpleCommand {
  /** Basename, lowercased: `rm`, `remove-item`. */
  name: string;
  args: string[];
}

/**
 * The command a simple command runs, past variable assignments and
 * prefix commands. `sh -c <line>` is the command of `<line>`; a shell
 * running a script file names nothing.
 */
function commandOf(words: readonly string[]): SimpleCommand | null {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    const name = basenameCommand(word).toLowerCase();
    if (PREFIX_COMMANDS.has(name)) {
      i += 1;
      while (i < words.length && words[i]!.startsWith("-")) i += 1;
      continue;
    }
    if (NESTED_SHELLS.has(name)) {
      for (let j = i + 1; j < words.length && words[j]!.startsWith("-"); j++) {
        if (/^-[a-z]*c[a-z]*$/i.test(words[j]!) || words[j] === "--command") {
          return commandOf(words.slice(j + 1));
        }
      }
      return null;
    }
    return { name, args: words.slice(i + 1) };
  }
  return null;
}

/** The words of `command` that name a file it changes. */
function changedOperands(command: SimpleCommand): string[] {
  const operands = plainOperands(command.args);
  if (CHANGES_EVERY_OPERAND.has(command.name)) return operands;
  if (CHANGES_LAST_OPERAND.has(command.name)) {
    return operands.length > 1 ? operands.slice(-1) : [];
  }
  if (
    IN_PLACE_EDITORS.has(command.name) &&
    command.args.some(
      (arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"),
    )
  ) {
    return operands;
  }
  if (command.name === "dd") {
    return command.args
      .filter((arg) => arg.startsWith("of="))
      .map((arg) => arg.slice("of=".length));
  }
  return [];
}

/** Arguments that are not flags; everything after `--` is an operand. */
function plainOperands(args: readonly string[]): string[] {
  const operands: string[] = [];
  let flagsDone = false;
  for (const arg of args) {
    if (!flagsDone && arg === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && arg.startsWith("-")) continue;
    operands.push(arg);
  }
  return operands;
}

function firstOperand(args: readonly string[]): string | undefined {
  return plainOperands(args)[0];
}

/** A word as an absolute path, or `undefined` when it cannot be one. */
function resolveTarget(word: string, dir: string): string | undefined {
  const expanded = word.replace(/^\$(?:HOME|\{HOME\})(?=\/|\\|$)/, homedir());
  if (expanded.length === 0 || expanded.startsWith("$")) return undefined;
  try {
    return resolve(resolveUserPath(expanded, dir));
  } catch {
    // A POSIX-absolute path on Windows: not a file this can name.
    return undefined;
  }
}
