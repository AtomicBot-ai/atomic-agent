/**
 * How `os.shell.run` reads its `cmd` / `args`: the argument coercion, the
 * direct-exec vs subshell decision, the spawn it leads to, and the
 * interpreter shapes whose approval grant is withheld. Split out of
 * shell.ts, which keeps the tool itself.
 */

import {
  buildDirectInvocation,
  buildSubshellInvocation,
  quoteCmdArg,
  type SpawnInvocation,
} from "../../../sandbox/shell-invocation.js";

/**
 * Coerce the model-supplied `args` field into a string array. Returns
 * the parsed list when the input is well-formed, or `null` when the
 * input has the wrong shape so the caller can return a structured
 * error to the model. Accepts:
 *   - `undefined` / missing -> [] (no extra args)
 *   - `string[]` -> coerced via String()
 *   - JSON-stringified array literal (some cloud providers
 *     double-serialise tool_call arguments) -> parsed + coerced
 * Anything else (object, scalar string with no JSON shape, number,
 * etc.) returns `null` and triggers the structured error path.
 */
export function coerceShellArgs(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((v) => String(v));
        }
      } catch {
        // fall through to error
      }
    }
  }
  return null;
}

export function describeArgsShape(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Shell metacharacters that only mean something inside a subshell (pipes,
 * sequencing, redirects, command/parameter substitution, grouping). Note
 * `*`/`?` are deliberately excluded — argv globs are expanded by
 * `expandShellGlobArgs` on the direct-exec path, so a bare `{cmd:"ls",
 * args:["*.png"]}` keeps working without spawning a subshell.
 */
const SHELL_METACHAR_RE = /[|&;<>$`(){}]/;

/**
 * `cmd.exe` internal commands that have no standalone executable on PATH.
 * A direct `spawn("echo", …)` fails with ENOENT on Windows because these
 * only exist inside the command interpreter — they must be routed through
 * the `cmd.exe` subshell. Real executables (`where.exe`, `find.exe`,
 * `sort.exe`, `more.com`) are intentionally excluded so they keep their
 * direct-exec argv semantics.
 */
const WINDOWS_CMD_BUILTINS: ReadonlySet<string> = new Set([
  "assoc",
  "call",
  "cd",
  "chdir",
  "cls",
  "color",
  "copy",
  "date",
  "del",
  "dir",
  "echo",
  "erase",
  "ftype",
  "md",
  "mkdir",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "set",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
]);

function isWindowsCmdBuiltin(cmd: string): boolean {
  // Builtins are never invoked by path, so a direct lowercase lookup is
  // sufficient — no basename stripping needed.
  return WINDOWS_CMD_BUILTINS.has(cmd.trim().toLowerCase());
}

/**
 * Decide whether `cmd` must be run through the OS subshell (`sh -c` /
 * `cmd.exe /c`) instead of a direct `spawn(cmd, args)`. Models routinely
 * emit a full shell command line in the `cmd` field (e.g.
 * `"ffprobe -v quiet ... f.mp3"` or `"pip3 list | grep foo"`). With a
 * direct exec that string is treated as a literal executable name and
 * fails with ENOENT. We route to a subshell when `cmd` carries shell
 * metacharacters, when it looks like a pre-joined command line (whitespace
 * present and no separate `args`), or — on Windows — when `cmd` is a
 * `cmd.exe` builtin (`echo`, `dir`, `type`, …) that has no standalone
 * executable to spawn directly.
 */
export function needsShellInterpretation(
  cmd: string,
  args: readonly string[],
): boolean {
  if (SHELL_METACHAR_RE.test(cmd)) return true;
  // On Windows the model may emit `%VAR%` expansion, which only means
  // something inside a `cmd.exe` subshell. `$` (POSIX) is already covered
  // by SHELL_METACHAR_RE above.
  if (process.platform === "win32" && /%[^%\s]+%/.test(cmd)) return true;
  // A bare cmd.exe builtin must go through the interpreter or `spawn`
  // ENOENTs. `cmd` here is a single token (metachar/pre-joined cases are
  // handled above), so a straight builtin lookup is safe.
  if (
    process.platform === "win32" &&
    !/\s/.test(cmd.trim()) &&
    isWindowsCmdBuiltin(cmd)
  ) {
    return true;
  }
  if (args.length === 0 && /\s/.test(cmd.trim())) return true;
  return false;
}

/**
 * The process `os.shell.run` starts for `cmd` / `execArgs` once
 * `needsShellInterpretation` has picked the mode.
 *
 * For the subshell path we hand a single command line to the OS shell
 * (`sh -c` / `cmd.exe /c`). When the model supplied separate argv tokens
 * alongside a shell-bearing `cmd`, quote them on Windows so paths with
 * spaces survive `cmd.exe` parsing. POSIX keeps the legacy raw join for
 * byte-identical behaviour. On Windows both the subshell and a direct
 * `cmd /c …` spawn verbatim (ATO-246: Node's own quoting turned
 * `dir C:\` into `dir C:\\`).
 */
export function resolveShellSpawn(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
): SpawnInvocation {
  if (!useShell) return buildDirectInvocation(cmd, execArgs);
  return buildSubshellInvocation(subshellLine(cmd, execArgs));
}

/** The line the subshell is handed: see `resolveShellSpawn`. */
function subshellLine(cmd: string, execArgs: readonly string[]): string {
  return execArgs.length > 0 && process.platform === "win32"
    ? [cmd, ...execArgs.map(quoteCmdArg)].join(" ")
    : [cmd, ...execArgs].join(" ");
}

/** Characters a POSIX shell reads literally outside quotes. */
const POSIX_PLAIN_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One argv token as a POSIX shell would need it written to read it back
 * unchanged: as is when it holds only plain characters, otherwise in
 * single quotes, an embedded `'` closed, escaped and reopened (`'\''`).
 */
export function quotePosixArg(token: string): string {
  if (token.length === 0) return "''";
  if (POSIX_PLAIN_TOKEN_RE.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * The command as the approval prompt shows it (ATO-433). A plain
 * `join(" ")` dropped the argv boundaries, so `bash` with
 * `["-c", "echo 'ux tour' > f.txt"]` read `bash -c echo 'ux tour' >
 * f.txt`, a different command from the one that runs.
 *
 * - Direct exec: every token quoted the way the platform shell would
 *   need it (`quotePosixArg`; `quoteCmdArg` on Windows), so pasting the
 *   preview into a terminal runs the same argv.
 * - Subshell: the exact line the subshell is handed, since that line
 *   is what runs (on POSIX the legacy raw join, on Windows with the
 *   arguments quoted for cmd.exe).
 *
 * Display only: the spawn, the guard and the write-target checks keep
 * reading the argv and lines they read before.
 */
export function formatShellPreview(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
): string {
  if (useShell) return subshellLine(cmd, execArgs);
  const quote = process.platform === "win32" ? quoteCmdArg : quotePosixArg;
  return [cmd, ...execArgs].map(quote).join(" ");
}

/**
 * Interpreter / wrapper binaries whose danger lives in their arguments,
 * not their name (`bash -c "<anything>"`). The shell tool withholds the
 * shape grant for these: a grant keyed on `bash` would silence
 * arbitrary code for the rest of the session. Matches the shells
 * covered by the guard's `dangerous.shell_dash_c` rule. The category
 * grant (the whole shell category) and a plain approve (this call only)
 * stay available.
 */
const OPAQUE_INTERPRETER_SHAPES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
]);

/** True when `[a]` (shape grant) must be withheld for `shape`. */
export function isOpaqueInterpreterShape(shape: string): boolean {
  return OPAQUE_INTERPRETER_SHAPES.has(shape);
}
