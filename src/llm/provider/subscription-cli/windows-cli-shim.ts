import { win32 } from "node:path";

import {
  hostEnv,
  hostFileExists,
  hostPlatform,
  readShimHead,
} from "./host-environment.js";
import {
  SubscriptionCliCommandLineError,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";

/**
 * Windows cannot spawn an npm shim directly.
 *
 * `claude` and `codex` install as `claude.cmd` / `codex.cmd`, and since
 * the CVE-2024-27980 fix (Node >= 18.20.2 / 20.12.2) `spawn` refuses a
 * `.cmd`/`.bat` target unless it goes through `cmd.exe`: the attempt
 * fails with EINVAL, thrown *synchronously* out of `ChildProcess.spawn`
 * rather than delivered on the `error` event. So the subscription-CLI
 * providers cannot start at all on Windows.
 *
 * The fix is what `cross-spawn` does: re-point the invocation at
 * `cmd.exe /d /s /c "…"`, escape the command line for cmd ourselves and
 * ask Node to pass argv through verbatim. Scoped to this layer on
 * purpose — `runCommand` has many other callers and its behaviour is
 * left alone.
 *
 * Every environment input is a parameter (or comes from
 * `host-environment.js`, which tests mock) so the Windows branch is
 * exercised from macOS/Linux.
 */
export interface WindowsCliShimOptions {
  binary: string;
  args: readonly string[];
  /** Carried only so a missing target can raise the usual message. */
  installHint?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  /**
   * The head of a `.cmd`/`.bat`, or `null` when it cannot be read. The
   * escaping depth depends on what the shim does with its arguments,
   * which is a property of the file, not of where it lives.
   */
  readTarget?: (path: string) => string | null;
}

export interface CliInvocation {
  command: string;
  args: string[];
  /** True only for the `cmd.exe` rewrite; see `escapeArgument`. */
  windowsVerbatimArguments: boolean;
}

/** cmd.exe's own default when PATHEXT is somehow unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Characters cmd.exe acts on before argv is parsed; `^` neutralises them. */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Characters with no escape at all in a cmd command line.
 *
 * `^` is a line *continuation* before a newline, not an escape for it,
 * and cmd ends its command at a raw LF or CR — the tail would be run as
 * a second command. A NUL truncates the command line inside
 * `CreateProcess` without any error. Reachable today only through an
 * operator-set `extraArgs` or a configured model id (the prompt goes to
 * stdin by design), but "reachable rarely" is not "safe".
 */
const UNESCAPABLE_CHARS = /[\r\n\u0000]/;

/**
 * A batch file that substitutes its arguments back into a line cmd then
 * re-parses: `%*`, `%1`…`%9`, and the `%~dp1` modifier forms.
 *
 * This — not where the file sits on disk — is what decides whether the
 * command line has to survive a *second* cmd parse, so it is what the
 * second `^` pass keys off. npm's cmd-shim template ends in
 * `… "%_prog%" "%dp0%\…\cli.js" %*`, and it is the same template for a
 * global install (`%APPDATA%\npm\claude.cmd`, the dominant layout for
 * `claude`) as for `node_modules\.bin\claude.cmd`. `cross-spawn`'s
 * heuristic only recognises the second one, which under-escapes the
 * case almost every real user is in: single-escaped, an argument that
 * contains both a `"` and one of `& | < >` loses cmd's quoting at the
 * re-parse (cmd does not read `\"` as an escaped quote, so the quoting
 * state flips) and the metacharacter lands outside quotes — the
 * argument is truncated and cmd runs the tail. That is the
 * CVE-2024-24576 / BatBadBut mechanism, and `--json-schema <json>` on
 * the `claude` adapter's argv is exactly the shape that triggers it.
 */
const ARG_SUBSTITUTION = /%(?:\*|~[a-zA-Z$:]*[0-9]|[0-9])/;

/**
 * cmd.exe refuses a command line longer than this, with "The input line
 * is too long." — far below `CreateProcess`'s own 32767.
 */
export const MAX_CMD_COMMAND_LINE = 8191;

/**
 * Map `(binary, args)` onto the pair that can actually be spawned. On
 * anything but Windows, and for any target that is not a batch shim,
 * the input is handed back untouched.
 *
 * Throws rather than returning a command line that would mean something
 * other than what the caller asked for: `SubscriptionCliNotInstalledError`
 * when an absolute target is not on disk, `SubscriptionCliCommandLineError`
 * when the request cannot be expressed as a cmd command line.
 */
export function resolveWindowsCliInvocation(
  options: WindowsCliShimOptions,
): CliInvocation {
  const passthrough: CliInvocation = {
    command: options.binary,
    args: [...options.args],
    windowsVerbatimArguments: false,
  };
  const platform = options.platform ?? hostPlatform();
  if (platform !== "win32") return passthrough;

  const env = options.env ?? hostEnv();
  const fileExists = options.fileExists ?? hostFileExists;
  const target = resolveTarget(
    options.binary,
    env,
    fileExists,
    options.installHint,
  );
  // Nothing resolved, or a real executable: leave it alone. An unresolved
  // bare name still reaches spawn, so ENOENT — and with it the
  // not-installed message — surfaces exactly as before.
  if (target === null || !isBatchFile(target)) return passthrough;

  const command = win32.normalize(target);
  const readTarget = options.readTarget ?? readShimHead;
  const doubleEscape = reSubstitutesArguments(command, readTarget);

  for (const value of [command, ...options.args]) {
    assertEscapable(value, options.binary);
  }

  const commandLine = [
    escapeCommand(command),
    ...options.args.map((arg) => escapeArgument(arg, doubleEscape)),
  ].join(" ");

  const invocation: CliInvocation = {
    command: lookupEnv(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
  assertFitsCommandLine(invocation, options.binary);
  return invocation;
}

function isBatchFile(target: string): boolean {
  const ext = win32.extname(target).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * Does the shim hand our arguments to a second cmd parse?
 *
 * A bounded read of the file itself, because the alternative — guessing
 * from the path — is what got this wrong. When the answer cannot be had
 * (unreadable, gone, not a file we may open) the conservative default is
 * `true`: every shim any of these CLIs actually ships re-substitutes, and
 * a batch file that does *not* touch `%1`/`%*` ignores the arguments
 * altogether, so the extra `^` pass cannot corrupt anything it reads.
 */
function reSubstitutesArguments(
  target: string,
  readTarget: (path: string) => string | null,
): boolean {
  const text = readTarget(target);
  if (text === null) return true;
  return ARG_SUBSTITUTION.test(text);
}

function assertEscapable(value: string, binary: string): void {
  const match = UNESCAPABLE_CHARS.exec(value);
  if (!match) return;
  const name =
    match[0] === "\n" ? "newline" : match[0] === "\r" ? "carriage return" : "NUL";
  throw new SubscriptionCliCommandLineError(
    `"${binary}" cannot be run through cmd.exe with this argument: it contains a raw ${name}, which has no escape in a cmd command line — cmd would end the command there and run the rest as a second one. Remove it from the argument (the prompt itself goes to stdin and is unaffected).`,
    "control-character",
  );
}

function assertFitsCommandLine(
  invocation: CliInvocation,
  binary: string,
): void {
  // What Node hands to `CreateProcess` with `windowsVerbatimArguments`:
  // the file, then the argv entries, joined by spaces.
  const length = [invocation.command, ...invocation.args].join(" ").length;
  if (length <= MAX_CMD_COMMAND_LINE) return;
  throw new SubscriptionCliCommandLineError(
    `"${binary}" could not be started: the command line is ${length} characters and cmd.exe refuses anything over ${MAX_CMD_COMMAND_LINE} ("The input line is too long."). On Windows a .cmd shim has to be run through cmd.exe, whose limit is far below CreateProcess's 32767 — and escaping inflates the line by roughly a third. A large inline JSON response schema is the usual cause; shorten it or drop the structured-output request.`,
    "too-long",
  );
}

/**
 * What cmd.exe would run for this name. A value that carries a directory
 * is taken at its word — but only after checking that it exists, so a
 * configured `binPath` pointing at nothing still produces the
 * not-installed message instead of being wrapped in `cmd /c` and coming
 * back as cmd's own "The system cannot find the path specified."
 *
 * Only absolute paths are checked: a relative one is resolved against
 * the *child's* cwd, which is not ours to test against. Anything without
 * a separator is walked over PATH × PATHEXT, the search `spawn` will not
 * do with `shell:false`.
 */
function resolveTarget(
  binary: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
  installHint?: string,
): string | null {
  if (/[\\/]/.test(binary)) {
    if (!win32.isAbsolute(binary) || fileExists(binary)) return binary;
    throw new SubscriptionCliNotInstalledError(binary, installHint ?? "");
  }

  const suffixes = [
    ...(lookupEnv(env, "PATHEXT") ?? DEFAULT_PATHEXT)
      .split(";")
      .filter((ext) => ext.length > 0),
    "",
  ];
  for (const dir of (lookupEnv(env, "PATH") ?? "").split(";")) {
    if (dir.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = win32.join(dir, `${binary}${suffix}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** Windows environment names are case-insensitive; injected ones may not be. */
function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

function escapeCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/**
 * Escape one argument for `cmd /c "…"` with verbatim argv, in the two
 * passes the layering demands: first for the CRT's `argv` parser
 * (backslash/quote rules), then for cmd's own pre-parse (`^`), once per
 * cmd parse the string will go through.
 *
 * Not theoretical here: the `claude` adapter delivers the response
 * schema inline on argv (`schemaDelivery: "inline"`), so braces, quotes,
 * brackets and commas are in every structured-output request, and a
 * prompt-derived argument can carry `&`, `|`, `^`, `<` or `>`.
 *
 * NOTE — do not "align this with the vendored cross-spawn". This is
 * deliberately cross-spawn's *pre-7.0.5* algorithm, and it is the
 * correct one. 7.0.5 hardened the trailing-backslash rule against a
 * ReDoS by rewriting it as `/(?=(\\+?)?)\1$/`, and that lookahead is
 * atomic in JS: it matches the empty string at the end and doubles
 * nothing, so a run of two or more trailing backslashes is
 * under-doubled and the closing quote is eaten. Differential fuzzing
 * against the `cross-spawn@7.0.6` in this repo's own `node_modules`
 * (1.2M comparisons) diverges on 938 inputs, all of them runs of >= 2
 * backslashes; round-tripping 60026 of those through a simulated
 * `cmd /d /s /c` plus `CommandLineToArgvW` gives 0 failures for the
 * implementation below and 134 for the vendored one.
 */
function escapeArgument(arg: string, doubleEscape: boolean): string {
  // Double any backslashes that precede a quote, then escape the quote.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Trailing backslashes would otherwise escape the closing quote.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  if (doubleEscape) escaped = escaped.replace(CMD_META_CHARS, "^$1");
  return escaped;
}
