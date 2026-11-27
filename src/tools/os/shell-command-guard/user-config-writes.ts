import type { ShellWord } from "./shell-line-lexer.js";

/**
 * Commands that change the user's own setup without naming a file in
 * home (review round 2 of ATO-2505): `git config --global` writes
 * `~/.gitconfig` (`core.hooksPath`, `credential.helper`, `core.pager`
 * all run code later), `--system` the machine's git config, `--file f`
 * the file `f`; `crontab` installs a job; `launchctl load|bootstrap`
 * and `systemctl --user enable|link` start one at every login.
 *
 * `undefined` for any other command, including a `git config` that
 * only reads (`--get`, `--list`, one key alone) or writes the repo's own
 * config.
 */
export interface UserConfigWrites {
  /** Files written, as words of the line (`~/.gitconfig`, `-f`'s value). */
  files: ShellWord[];
  /** What else is changed, as the card names it. */
  other: string[];
}

const GIT_OPTIONS_WITH_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)$/;
const CONFIG_READS = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list)$/;
const CONFIG_WRITES = /^(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|-e|--edit)$/;
const CONFIG_VALUE_FLAGS = /^(?:-f|--file|--blob|--type|--default|--comment|--value)$/;
const CONFIG_SUBCOMMAND_WRITES: ReadonlySet<string> = new Set(["set", "unset", "rename-section", "remove-section", "edit"]);
const CONFIG_SUBCOMMAND_READS: ReadonlySet<string> = new Set(["get", "list"]);

export function userConfigWrites(name: string, args: readonly ShellWord[]): UserConfigWrites | undefined {
  if (name === "git") return gitConfigWrites(args);
  if (name === "crontab") {
    const flags = args.map((arg) => arg.text);
    const readsOnly = flags.some((f) => /^-[a-z]*l/.test(f)) && !flags.some((f) => /^-[a-z]*[er]/.test(f));
    return readsOnly ? undefined : { files: [], other: ["your crontab"] };
  }
  if (name === "launchctl") {
    const sub = args.find((arg) => !arg.text.startsWith("-"))?.text.toLowerCase();
    return sub !== undefined && ["load", "bootstrap", "enable", "submit"].includes(sub)
      ? { files: [], other: [`a login job (launchctl ${sub})`] }
      : undefined;
  }
  if (name === "systemctl") {
    const user = args.some((arg) => arg.text === "--user");
    const sub = args.find((arg) => !arg.text.startsWith("-"))?.text.toLowerCase();
    return user && sub !== undefined && ["enable", "link", "edit", "preset", "add-wants", "add-requires"].includes(sub)
      ? { files: [], other: [`a systemd user unit (systemctl --user ${sub})`] }
      : undefined;
  }
  return undefined;
}

function gitConfigWrites(args: readonly ShellWord[]): UserConfigWrites | undefined {
  let k = 0;
  while (k < args.length && args[k]!.text.startsWith("-")) {
    k += GIT_OPTIONS_WITH_VALUE.test(args[k]!.text) ? 2 : 1;
  }
  if (args[k]?.text !== "config") return undefined;
  const rest = args.slice(k + 1);
  let global = false;
  let system = false;
  let write = false;
  let read = false;
  const files: ShellWord[] = [];
  const operands: ShellWord[] = [];
  for (let j = 0; j < rest.length; j++) {
    const word = rest[j]!;
    const text = word.text;
    if (text === "--global") global = true;
    else if (text === "--system") system = true;
    else if (text.startsWith("--file=")) files.push({ ...word, text: text.slice("--file=".length) });
    else if (text === "-f" || text === "--file") {
      const next = rest[j + 1];
      if (next !== undefined) files.push(next);
      j += 1;
    } else if (CONFIG_WRITES.test(text)) write = true;
    else if (CONFIG_READS.test(text)) read = true;
    else if (CONFIG_VALUE_FLAGS.test(text)) j += 1;
    else if (!text.startsWith("-")) operands.push(word);
  }
  const sub = operands[0]?.text;
  if (sub !== undefined && CONFIG_SUBCOMMAND_WRITES.has(sub)) write = true;
  else if (sub !== undefined && CONFIG_SUBCOMMAND_READS.has(sub)) read = true;
  else if (!read && operands.length >= 2) write = true;
  if (!write) return undefined;
  const written: ShellWord[] = [...files];
  if (global) written.push({ text: "~/.gitconfig", dynamic: false });
  const other = system ? ["the system git config (git config --system)"] : [];
  return written.length > 0 || other.length > 0 ? { files: written, other } : undefined;
}
