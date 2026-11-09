/**
 * The shell guard for `verify.run` (ATO-1266).
 *
 * `verify.run` executes a model-chosen command (kind `command`, the
 * `start` of a service or a page) in a copy of the working directory.
 * The copy is not a sandbox: `rm -rf ~` there reaches the real home
 * directory. So every command it would start goes through the same
 * pre-exec guard as `os.shell.run`: a hardline or policy rule refuses it
 * before anything runs, a `dangerous.*` rule makes it ask as
 * `shell_dangerous` every time, whatever a fan-out scope or a `shell`
 * grant covers.
 */
import {
  checkBrowserBypassArgv,
  checkBrowserBypassLine,
  checkShellCommandGuard,
  type GuardVerdict,
  type ShellGuardPolicy,
} from "../os/shell-command-guard/index.js";
import { needsShellInterpretation } from "../os/shell/shell-interpretation.js";
import { isDangerousGuardRule } from "../os/shell/shell.js";
import type { VerifyRunArgs } from "./verify-run-args.js";

/** One command `verify.run` would start, with the guard's answer. */
export interface VerifyGuardedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly verdict: GuardVerdict;
}

/** The guard's answer for a whole `verify.run` call. */
export interface VerifyGuardResult {
  /** The first refused command, if any: nothing runs. */
  readonly blocked: VerifyGuardedCommand | null;
  /** Commands the dangerous layer matched: the call asks as `shell_dangerous`. */
  readonly dangerous: readonly VerifyGuardedCommand[];
}

/** Every command the call would start: none for a plain page. */
export function verifyRunCommands(
  args: VerifyRunArgs,
): { cmd: string; args: readonly string[] }[] {
  if (args.kind === "command") {
    return args.cmd === undefined ? [] : [{ cmd: args.cmd, args: args.args ?? [] }];
  }
  if (args.start === undefined || args.start.cmd.length === 0) return [];
  return [{ cmd: args.start.cmd, args: args.start.args ?? [] }];
}

/**
 * The guard verdict for one command, read the way `os.shell.run` reads
 * it: a browser-driving bypass first, then the rule layers; a command
 * line that needs a subshell is judged on its whitespace tokens so the
 * hardline and dangerous rules see the real binaries.
 */
export function guardVerifyCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  policy?: ShellGuardPolicy,
): GuardVerdict {
  const useShell = needsShellInterpretation(cmd, args);
  // No glob expansion: `verify.run` spawns argv as given.
  const execArgs = [...args];
  const commandLine = [cmd, ...execArgs].join(" ");
  const tokens = useShell ? commandLine.split(/\s+/).filter((t) => t.length > 0) : null;
  const input =
    tokens !== null && tokens.length > 0
      ? { cmd: tokens[0]!, rawArgs: tokens.slice(1), cwd }
      : { cmd, rawArgs: execArgs, cwd };
  return (
    (useShell
      ? checkBrowserBypassLine(commandLine, cwd)
      : checkBrowserBypassArgv(cmd, execArgs, cwd)) ??
    checkShellCommandGuard(input, policy)
  );
}

export function guardVerifyRun(
  args: VerifyRunArgs,
  cwd: string,
  policy?: ShellGuardPolicy,
): VerifyGuardResult {
  const dangerous: VerifyGuardedCommand[] = [];
  for (const command of verifyRunCommands(args)) {
    const verdict = guardVerifyCommand(command.cmd, command.args, cwd, policy);
    const guarded = { ...command, verdict };
    if (verdict.action === "block") return { blocked: guarded, dangerous };
    if (verdict.action === "approval_required" && isDangerousGuardRule(verdict.rule)) {
      dangerous.push(guarded);
    }
  }
  return { blocked: null, dangerous };
}
