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
 *
 * On Windows the spawn must be verbatim (`windowsVerbatimArguments`),
 * the way Node itself runs `shell: true`. Without it Node quotes the
 * line by the MSVCRT rules cmd.exe does not follow: a trailing `\`
 * before the added closing quote is doubled (`dir C:\` reaches cmd as
 * `dir C:\\` — "The filename, directory name, or volume label syntax is
 * incorrect.") and every `"` inside becomes `\"`, which cmd keeps
 * literally.
 */
export interface SpawnInvocation {
  command: string;
  args: string[];
  /** Hand `args` to `CreateProcess` as written; only ever true on Windows. */
  windowsVerbatimArguments: boolean;
}

export type SubshellInvocation = SpawnInvocation;

export function buildSubshellInvocation(
  commandLine: string,
): SubshellInvocation {
  if (process.platform === "win32") {
    const comSpec =
      typeof process.env.ComSpec === "string" && process.env.ComSpec.length > 0
        ? process.env.ComSpec
        : "cmd.exe";
    // `/s` strips exactly the first and the last quote of what follows
    // `/c`, so the line inside reaches cmd byte for byte, its own quotes
    // included.
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: "sh",
    args: ["-c", commandLine],
    windowsVerbatimArguments: false,
  };
}

/** `cmd`, `cmd.exe`, or a path to either — the test Node uses for `shell`. */
const CMD_EXE_RE = /^(?:.*[\\/])?cmd(?:\.exe)?$/i;

/**
 * The spawn for a command run directly, without our own subshell. Only
 * one target is not passed through: `cmd.exe` itself on Windows
 * (`{cmd:"cmd", args:["/c","dir","C:\\"]}`). What follows its `/c` is a
 * command line cmd reads with its own rules, so Node's MSVCRT quoting
 * mangles it exactly as it does a subshell line — `["/c","dir C:\\"]`
 * reached cmd as `"dir C:\\"`. The args go verbatim instead, a token
 * quoted only to keep its spaces together (see `quoteCmdLineToken`).
 */
export function buildDirectInvocation(
  command: string,
  args: readonly string[],
): SpawnInvocation {
  if (process.platform === "win32" && CMD_EXE_RE.test(command)) {
    return {
      command,
      args: args.map(quoteCmdLineToken),
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: [...args], windowsVerbatimArguments: false };
}

/**
 * One argv token of a verbatim `cmd.exe` command line. Node's quoting
 * minus the parts that only mean something to MSVCRT: a token with
 * whitespace is wrapped in quotes (no backslash doubling — cmd does not
 * treat `\` as an escape), and one that already carries a `"` was quoted
 * for cmd by whoever wrote it, so it goes as is. Operators (`&&`, `|`)
 * stay bare, so cmd still interprets them as it did before.
 */
function quoteCmdLineToken(token: string): string {
  if (token.length === 0) return '""';
  if (token.includes('"') || !/\s/.test(token)) return token;
  return `"${token}"`;
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
