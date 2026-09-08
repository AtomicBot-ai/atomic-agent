import { win32 } from "node:path";

import {
  hostEnv,
  hostFileStatus,
  hostPlatform,
  readShimHead,
  type FileStatus,
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
  /** Present / absent / cannot-tell; see `hostFileStatus`. */
  fileStatus?: (path: string) => FileStatus;
  /**
   * The head of a `.cmd`/`.bat`, or `null` when it cannot be read —
   * which includes a read that stopped at the probe cap. The escaping
   * depth depends on what the shim does with its arguments, which is a
   * property of the file, not of where it lives.
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
 * Headroom held back for the line the *shim* builds.
 *
 * The limit applies to every command line cmd parses, and a shim that
 * substitutes `%*` builds a second one:
 * `"%_prog%" "%dp0%\…\cli.js" <our arguments>`. That line can be the
 * longer of the two — the arguments arrive one `^` layer lighter, but
 * the shim's prefix replaces the (shorter) `cmd.exe /d /s /c "` we
 * measured. For the real global `claude.cmd` the crossover leaves a
 * window ~76 characters wide in which the outer line passes this check
 * and cmd then refuses the inner one with the opaque message the check
 * exists to replace.
 *
 * A margin rather than a computed length, deliberately: at the point we
 * read the shim its line is `%_prog%` and `%dp0%`, and both expand at
 * run time to paths we do not have (`%_prog%` is chosen by a branch
 * *inside* the file). Measuring the literal text would be false
 * precision. 512 covers npm's ~170-character line with a deeply nested
 * install path and still leaves 94% of the budget — and the budget is
 * only ever contested by a large inline JSON schema, a case that
 * already ends in this error, just with an actionable message instead
 * of cmd's. Charged only when the shim actually re-substitutes: a batch
 * file that ignores its arguments builds no second line.
 */
export const SHIM_SUBSTITUTION_MARGIN = 512;

/**
 * Map `(binary, args)` onto the pair that can actually be spawned. On
 * anything but Windows, and for any target that is not a batch shim,
 * the input is handed back untouched.
 *
 * Throws rather than returning a command line that would mean something
 * other than what the caller asked for: `SubscriptionCliNotInstalledError`
 * when an absolute target is known not to be on disk,
 * `SubscriptionCliCommandLineError` when the request cannot be expressed
 * as a cmd command line.
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
  const fileStatus = options.fileStatus ?? hostFileStatus;
  const target = resolveTarget(
    options.binary,
    env,
    fileStatus,
    options.installHint,
  );
  // Nothing resolved, or a real executable: leave it alone. An unresolved
  // bare name still reaches spawn, so ENOENT — and with it the
  // not-installed message — surfaces exactly as before.
  if (target === null || !isBatchFile(target)) return passthrough;

  const command = win32.normalize(target);
  const readTarget = options.readTarget ?? readShimHead;
  const doubleEscape = reSubstitutesArguments(command, readTarget);

  assertEscapable(command, options.binary, "path");
  for (const value of options.args) {
    assertEscapable(value, options.binary, "argument");
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
  assertFitsCommandLine(invocation, options.binary, doubleEscape);
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
 * (unreadable, gone, not a file we may open, or bigger than the probe
 * window) the conservative default is `true`: every shim any of these
 * CLIs actually ships re-substitutes, and a batch file that does *not*
 * touch `%1`/`%*` ignores the arguments altogether, so the extra `^`
 * pass cannot corrupt anything it reads.
 */
function reSubstitutesArguments(
  target: string,
  readTarget: (path: string) => string | null,
): boolean {
  const text = readTarget(target);
  if (text === null) return true;
  return ARG_SUBSTITUTION.test(text);
}

function assertEscapable(
  value: string,
  binary: string,
  role: "path" | "argument",
): void {
  const match = UNESCAPABLE_CHARS.exec(value);
  if (!match) return;
  const name =
    match[0] === "\n"
      ? "newline"
      : match[0] === "\r"
        ? "carriage return"
        : "NUL";
  // The same characters are fatal in the target's own path, but "with
  // this argument" would then send the reader looking through argv for
  // something that is not there.
  const subject =
    role === "path"
      ? "at all: its resolved path contains"
      : "with this argument: it contains";
  throw new SubscriptionCliCommandLineError(
    `"${binary}" cannot be run through cmd.exe ${subject} a raw ${name}, which has no escape in a cmd command line — cmd would end the command there and run the rest as a second one. Remove it from the ${role} (the prompt itself goes to stdin and is unaffected).`,
    "control-character",
  );
}

function assertFitsCommandLine(
  invocation: CliInvocation,
  binary: string,
  reSubstitutes: boolean,
): void {
  // What Node hands to `CreateProcess` with `windowsVerbatimArguments`:
  // the file, then the argv entries, joined by spaces.
  const length = [invocation.command, ...invocation.args].join(" ").length;
  const budget =
    MAX_CMD_COMMAND_LINE - (reSubstitutes ? SHIM_SUBSTITUTION_MARGIN : 0);
  if (length <= budget) return;
  const shimNote = reSubstitutes
    ? `, and the .cmd shim substitutes the arguments back into a second command line of its own that the same limit applies to, so ${SHIM_SUBSTITUTION_MARGIN} characters are held back for it`
    : "";
  throw new SubscriptionCliCommandLineError(
    `"${binary}" could not be started: the command line is ${length} characters and only ${budget} are usable. cmd.exe refuses anything over ${MAX_CMD_COMMAND_LINE} ("The input line is too long.")${shimNote}. On Windows a .cmd shim has to be run through cmd.exe, whose limit is far below CreateProcess's 32767 — and escaping inflates the line by roughly a third. A large inline JSON response schema is the usual cause; shorten it or drop the structured-output request.`,
    "too-long",
  );
}

/**
 * What cmd.exe would run for this name. A value that carries a directory
 * is taken at its word — but only after checking that it is not plainly
 * missing, so a configured `binPath` pointing at nothing still produces
 * the not-installed message instead of being wrapped in `cmd /c` and
 * coming back as cmd's own "The system cannot find the path specified."
 * "Cannot tell" — a path we may not stat, a share that did not answer —
 * is not "missing", and that target is handed to cmd like any other.
 *
 * Only absolute paths are checked: a relative one (`tools\claude.cmd`,
 * or the drive-relative `C:claude.cmd`, which is relative to that
 * drive's own current directory) resolves against a cwd that is not
 * ours to test against, so it is wrapped and left to cmd, which reports
 * its own error if it is not there. Anything with neither a separator
 * nor a drive letter is walked over PATH × PATHEXT, the search `spawn`
 * will not do with `shell:false`.
 */
function resolveTarget(
  binary: string,
  env: NodeJS.ProcessEnv,
  fileStatus: (path: string) => FileStatus,
  installHint?: string,
): string | null {
  if (/[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary)) {
    if (!win32.isAbsolute(binary)) return binary;
    if (fileStatus(binary) !== "absent") return binary;
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
      if (fileStatus(candidate) === "present") return candidate;
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
 * The CRT half is one left-to-right scan rather than the two regex
 * passes cross-spawn uses, and it encodes exactly cross-spawn's
 * *pre-7.0.5* rules:
 *
 *   - a run of backslashes before a `"` is doubled, and the quote is
 *     then escaped as `\"`;
 *   - a run of backslashes at the end of the argument is doubled, so it
 *     cannot escape the closing quote we add;
 *   - everything else is copied through.
 *
 * NOTE — do not "align this with the vendored cross-spawn". 7.0.5
 * rewrote *two* rules. The ReDoS it was fixing is in the quote rule,
 * `arg.replace(/(\\*)"/g, …)`, which is quadratic on a long run of
 * backslashes that never reaches a quote: measured in-process here at
 * 93 ms for 8k backslashes, 403 ms for 16k and 1.47 s for 32k, all of
 * it synchronous, on the TUI's event loop, in the spawn path, and paid
 * *before* the length check that would reject the argument anyway. The
 * scan below is linear (0.2 ms for the same 32k) and keeps the old
 * semantics character-for-character — a differential test pins it
 * against the regex form over a random corpus.
 *
 * What must NOT be adopted is 7.0.5's *other* change, the trailing
 * backslash rule as `/(?=(\\+?)?)\1$/`: that lookahead is atomic in JS,
 * so it matches the empty string at the end and doubles nothing, and a
 * run of two or more trailing backslashes is under-doubled — the
 * closing quote is then eaten. Differential fuzzing against the
 * `cross-spawn@7.0.6` in this repo's own `node_modules` (1.2M
 * comparisons) diverges on 938 inputs, all of them runs of >= 2
 * backslashes; round-tripping 60026 of those through a simulated
 * `cmd /d /s /c` plus `CommandLineToArgvW` gives 0 failures for the
 * implementation below and 134 for the vendored one.
 */
function escapeArgument(arg: string, doubleEscape: boolean): string {
  let escaped = "";
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      escaped += "\\".repeat(backslashes * 2) + '\\"';
    } else {
      escaped += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  escaped += "\\".repeat(backslashes * 2);
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  if (doubleEscape) escaped = escaped.replace(CMD_META_CHARS, "^$1");
  return escaped;
}
