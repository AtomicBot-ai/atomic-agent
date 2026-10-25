import { coerceShellArgs } from "./shell-interpretation.js";

/**
 * The `cmd` a command-form call left out, read back from its `args`,
 * or `null` when the call cannot be read without guessing.
 *
 * Over `native_tools` some cloud models (DeepSeek V4.1 Flash, GLM 5.3
 * Flash at long context) send `{"args": ["-c", "<line>"], "timeoutMs": …}`
 * or `{"args": ["git", "status"]}` with no `cmd`. The provider schema
 * cannot refuse it: the four forms share one object with no required
 * key, and a top-level `anyOf` is rejected by several providers. The
 * call was refused here instead, after a full round-trip, and the model
 * often resent the same shape (#901).
 *
 * Two shapes say what they mean:
 *  - `["-c", line]`: a shell tail. The line becomes `cmd`, which runs
 *    through the OS subshell as written (the documented full-command-line
 *    form), so the guard sees the real binaries.
 *  - `[program, ...rest]` with a program that is not a flag: the first
 *    token is the program.
 * Anything else (another leading flag, an empty token, no args) is left
 * alone and still refused.
 *
 * The recovered call goes through the same guard and approval as any
 * other: this only fills in the key, it never widens what may run.
 */
export function recoverMissingShellCmd(
  rawArgs: Record<string, unknown>,
): { cmd: string; args: string[] } | null {
  const cmd = rawArgs.cmd;
  if (cmd !== undefined && cmd !== null && cmd !== "") return null;
  const tokens = coerceShellArgs(rawArgs.args);
  if (tokens === null || tokens.length === 0) return null;
  const first = tokens[0]!.trim();
  if (first.length === 0) return null;
  if (first === "-c") {
    const line = tokens[1]?.trim() ?? "";
    if (tokens.length !== 2 || line.length === 0) return null;
    return { cmd: line, args: [] };
  }
  if (first.startsWith("-")) return null;
  return { cmd: first, args: tokens.slice(1) };
}

/**
 * Said above the output of a recovered call, so the model sends `cmd`
 * next time instead of relying on the recovery.
 */
export function missingCmdNotice(cmd: string, args: readonly string[]): string {
  const shown = JSON.stringify({ cmd, args });
  return `os.shell.run: the call had no \`cmd\`; ran it as ${shown}. Name the program in \`cmd\` and put its arguments in \`args\`.`;
}
