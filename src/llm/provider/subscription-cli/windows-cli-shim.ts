import { existsSync } from "node:fs";
import { win32 } from "node:path";

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
 * Every environment input is a parameter so the Windows branch is
 * exercised from macOS/Linux in tests.
 */
export interface WindowsCliShimOptions {
  binary: string;
  args: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
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

/** npm's `node_modules\.bin` shims re-enter cmd once more — see below. */
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/**
 * Map `(binary, args)` onto the pair that can actually be spawned. On
 * anything but Windows, and for any target that is not a batch shim,
 * the input is handed back untouched.
 */
export function resolveWindowsCliInvocation(
  options: WindowsCliShimOptions,
): CliInvocation {
  const passthrough: CliInvocation = {
    command: options.binary,
    args: [...options.args],
    windowsVerbatimArguments: false,
  };
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return passthrough;

  const env = options.env ?? process.env;
  const target = resolveTarget(options.binary, env, options.fileExists ?? existsSync);
  // Nothing resolved, or a real executable: leave it alone. An unresolved
  // bare name still reaches spawn, so ENOENT — and with it the
  // not-installed message — surfaces exactly as before.
  if (target === null || !isBatchFile(target)) return passthrough;

  // npm's `node_modules\.bin` shims pass their arguments through a
  // second cmd layer, which consumes one round of `^` escaping.
  const doubleEscape = CMD_SHIM.test(target);
  const commandLine = [
    escapeCommand(win32.normalize(target)),
    ...options.args.map((arg) => escapeArgument(arg, doubleEscape)),
  ].join(" ");

  return {
    command: lookupEnv(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function isBatchFile(target: string): boolean {
  const ext = win32.extname(target).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * What cmd.exe would run for this name. A value that already carries a
 * directory or an extension is taken at its word; a bare name is walked
 * over PATH × PATHEXT, the search `spawn` will not do with `shell:false`.
 */
function resolveTarget(
  binary: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string | null {
  if (/[\\/]/.test(binary) || win32.extname(binary).length > 0) return binary;

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
 * (backslash/quote rules), then for cmd's own pre-parse (`^`).
 *
 * Not theoretical here: the `claude` adapter delivers the response
 * schema inline on argv (`schemaDelivery: "inline"`), so braces, quotes,
 * brackets and commas are in every structured-output request, and a
 * prompt-derived argument can carry `&`, `|`, `^`, `<` or `>`.
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
