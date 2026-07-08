/**
 * Chooses the OS subshell used to interpret a pre-joined command line
 * (pipes, `&&`/`||`, redirects, substitution). This is the single seam
 * that keeps `os.shell.run` and any other subshell caller cross-platform.
 *
 * - POSIX: `sh -c "<line>"`.
 * - Windows: `cmd.exe /d /s /c "<line>"` via `%ComSpec%`. We deliberately
 *   pick `cmd.exe` over `powershell.exe` because the default Windows
 *   PowerShell (5.1) does not support `&&` / `||`, which the model emits
 *   routinely; `cmd.exe` handles `&&`, `||` and `|` close to POSIX
 *   semantics. Flags: `/d` skips AutoRun registry commands, `/s` gives
 *   predictable quote handling for the trailing command string, `/c`
 *   runs and exits.
 */
export interface SubshellInvocation {
  command: string;
  args: string[];
}

export function buildSubshellInvocation(commandLine: string): SubshellInvocation {
  if (process.platform === "win32") {
    const comSpec =
      typeof process.env.ComSpec === "string" && process.env.ComSpec.length > 0
        ? process.env.ComSpec
        : "cmd.exe";
    return { command: comSpec, args: ["/d", "/s", "/c", commandLine] };
  }
  return { command: "sh", args: ["-c", commandLine] };
}

/**
 * Quote a single argv token for a `cmd.exe /c` command line. cmd.exe does
 * not follow the MSVCRT argv quoting rules of `spawn` (which we bypass by
 * pre-joining into one string), so we wrap any token containing a space or
 * a cmd metacharacter in double quotes and escape embedded quotes. Tokens
 * that already carry shell metacharacters the caller wants interpreted
 * (pipes, redirects) must not be quoted, so callers only pass argv tokens
 * (never the operators) through this helper.
 */
const CMD_NEEDS_QUOTING_RE = /[\s"^&|<>()%!]/;

export function quoteCmdArg(token: string): string {
  if (token.length === 0) return '""';
  if (!CMD_NEEDS_QUOTING_RE.test(token)) return token;
  // Escape embedded double quotes by doubling them (cmd convention) and
  // wrap the whole token so spaces/metacharacters stay literal.
  return `"${token.replace(/"/g, '""')}"`;
}
