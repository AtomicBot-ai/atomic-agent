import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { UserCommand, UserCommandProblem } from "../../plugins/user-commands.js";
import { resolveSlashCommand } from "../commands/slash-commands.js";

/**
 * One chat line per own command file that did not load as written
 * (ATO-2773). The palette used to drop a `help.md` (a built-in's name)
 * or a bad file without a word. Precedent: Claude Code reports command
 * load errors at start and in /doctor.
 *
 * Each line carries a key so the caller shows it once per terminal
 * session, although the folders are scanned every few seconds.
 */
export interface UserCommandWarning {
  key: string;
  text: string;
}

export function userCommandWarnings(
  list: { commands: readonly UserCommand[]; problems: readonly UserCommandProblem[] },
  workingDir: string,
  home: string = homedir(),
): UserCommandWarning[] {
  const out: UserCommandWarning[] = [];
  for (const command of list.commands) {
    // Built-in names and aliases always win (`pluginSlashCommands`).
    if (resolveSlashCommand(command.name) === null) continue;
    const reason = `same name as built-in /${command.name}, rename the file`;
    out.push(line(command.file, reason, true, workingDir, home));
  }
  for (const problem of list.problems) {
    out.push(line(problem.file, problem.reason, problem.skipped, workingDir, home));
  }
  return out;
}

function line(
  file: string,
  reason: string,
  skipped: boolean,
  workingDir: string,
  home: string,
): UserCommandWarning {
  const shown = shownPath(file, workingDir, home);
  const text = skipped
    ? `Own command ${shown} skipped: ${reason}.`
    : `Own command ${shown}: ${reason}.`;
  return { key: `${file}\n${reason}`, text };
}

/** Relative to the project when inside it, else `~` for the home folder. */
export function shownPath(file: string, workingDir: string, home: string): string {
  const inProject = relative(workingDir, file);
  if (inProject !== "" && !inProject.startsWith("..") && !isAbsolute(inProject)) return inProject;
  const inHome = relative(home, file);
  if (home !== "" && inHome !== "" && !inHome.startsWith("..") && !isAbsolute(inHome)) {
    return join("~", inHome);
  }
  return file;
}
