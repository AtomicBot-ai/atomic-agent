import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { runCommand } from "../../sandbox/command-runner.js";
import {
  buildSubshellInvocation,
  quoteCmdArg,
} from "../../sandbox/shell-invocation.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import { resolveUserPath } from "./expand-home.js";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";
import {
  checkShellCommandGuard,
  isGogCommand,
} from "./shell-command-guard/index.js";

const GOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GOG_COMPRESS_OPTIONS = {
  maxSummaryLength: 64_000,
  maxTailLines: 10_000,
} as const;

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
function coerceShellArgs(value: unknown): string[] | null {
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

function describeArgsShape(value: unknown): string {
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

export function buildOsShellTool(options: DangerousToolOptions): ToolDefinition {
  return {
    name: "os.shell.run",
    description:
      "Run an OS command in the session working directory. Prefer the structured form `{cmd, args:[...]}` (argv globs `*`/`?` are expanded). Shell metacharacters (`|`, `&&`, `;`, `>`, `<`, `$`, backticks) are interpreted via the OS subshell (`sh -c` on macOS/Linux, `cmd.exe /c` on Windows) — a full command line passed as `cmd` (e.g. `\"ffprobe -v quiet … f.mp3\"` or `\"pip3 list | grep foo\"`) runs as written. Do not use for deleting user files — use `os.fs.trash` unless the user explicitly requests permanent shell deletion. Runs through a pre-exec guard: safe commands run directly, risky commands require approval, catastrophic commands are blocked without execution. By default there is no timeout (the command runs until it exits or the turn is cancelled); pass `timeoutMs` to set an explicit limit.",
    readonly: false,
    async run(rawArgs, ctx) {
      const cmd = rawArgs.cmd;
      if (typeof cmd !== "string" || cmd.length === 0) {
        throw new Error("os.shell.run: `cmd` must be a non-empty string");
      }
      const rawArgList = coerceShellArgs(rawArgs.args);
      if (rawArgList === null) {
        // Some models (notably cloud `native_tools` providers under
        // tool_choice="auto") double-serialise array arguments into a
        // JSON string. Treating that as "no args" silently dropped the
        // operator's intent; surfacing a structured error gives the
        // model a chance to retry with the right shape instead.
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output:
            "os.shell.run: `args` must be an array of strings (got " +
            describeArgsShape(rawArgs.args) +
            "). Pass arguments as JSON array literal, e.g. {\"cmd\":\"ls\",\"args\":[\"-la\",\"./src\"]}.",
          details: {
            cmd,
            rawArgsType: describeArgsShape(rawArgs.args),
          },
        });
      }
      const cwd =
        typeof rawArgs.cwd === "string" && rawArgs.cwd.length > 0
          ? resolveUserPath(rawArgs.cwd, ctx.workingDir)
          : ctx.workingDir;
      // No default timeout: when the model does not pass `timeoutMs`
      // explicitly the command runs unbounded (long installs like
      // `brew install` need this). `0` signals "no timeout" to the
      // command runner; the turn's abort signal stays the safety valve.
      const timeoutMs =
        typeof rawArgs.timeoutMs === "number" &&
        Number.isFinite(rawArgs.timeoutMs)
          ? rawArgs.timeoutMs
          : 0;

      // Two execution modes. Direct-exec (`spawn(cmd, args)`) keeps argv
      // semantics and shell-glob expansion. Subshell (`sh -c <line>`) is
      // used when the model emits shell metacharacters or a pre-joined
      // command line in `cmd` (the common ENOENT trap). In subshell mode
      // the guard inspects a tokenised view of the full command line so
      // hardline/dangerous rules still match the real binaries.
      const useShell = needsShellInterpretation(cmd, rawArgList);
      const execArgs = useShell
        ? rawArgList
        : expandShellGlobArgs(cmd, rawArgList, cwd);
      const commandLine = [cmd, ...execArgs].join(" ");
      const guardTokens = useShell
        ? commandLine.split(/\s+/).filter((t) => t.length > 0)
        : null;
      const guardInput =
        useShell && guardTokens && guardTokens.length > 0
          ? { cmd: guardTokens[0]!, rawArgs: guardTokens.slice(1), cwd }
          : { cmd, rawArgs: execArgs, cwd };
      const gogProbe = guardInput.cmd;

      const guardVerdict = checkShellCommandGuard(guardInput);
      if (guardVerdict.action === "block") {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: `blocked by shell guard: ${guardVerdict.rule} - ${guardVerdict.reason}`,
          details: {
            cmd,
            rawArgs: rawArgList,
            cwd,
            shell: useShell,
            guardVerdict: guardVerdict.action,
            guardRule: guardVerdict.rule,
            guardReason: guardVerdict.reason,
          },
        });
      }

      if (guardVerdict.action === "approval_required") {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "os.shell.run",
            reason: `${guardVerdict.reason} in ${cwd}`,
            preview: commandLine,
            affectedResources: [cwd],
          },
          ctx.signal,
        );
      }

      // For the subshell path we hand a single command line to the OS
      // shell (`sh -c` / `cmd.exe /c`). When the model supplied separate
      // argv tokens alongside a shell-bearing `cmd`, quote them on Windows
      // so paths with spaces survive `cmd.exe` parsing. POSIX keeps the
      // legacy raw join for byte-identical behaviour.
      const subshellCommandLine =
        execArgs.length > 0 && process.platform === "win32"
          ? [cmd, ...execArgs.map(quoteCmdArg)].join(" ")
          : commandLine;
      const subshell = buildSubshellInvocation(subshellCommandLine);
      const result = useShell
        ? await runCommand(subshell.command, subshell.args, {
            cwd,
            timeoutMs,
            signal: ctx.signal,
            ...(isGogCommand(gogProbe)
              ? { maxOutputBytes: GOG_MAX_OUTPUT_BYTES }
              : {}),
          })
        : await runCommand(cmd, execArgs, {
            cwd,
            timeoutMs,
            signal: ctx.signal,
            ...(isGogCommand(cmd)
              ? { maxOutputBytes: GOG_MAX_OUTPUT_BYTES }
              : {}),
          });
      const status = result.exitCode === 0 ? "ok" : "error";
      const header = `$ ${commandLine}\nexit: ${result.exitCode ?? "signal:" + result.signal}${result.timedOut ? " (timed out)" : ""}`;
      const body = [result.stdout, result.stderr]
        .filter((s) => s.trim().length > 0)
        .join("\n---\n");
      return compressToolResult(
        {
          tool: "os.shell.run",
          status,
          output: `${header}\n${body}`,
          details: {
            cmd,
            args: execArgs,
            rawArgs: rawArgList,
            cwd,
            shell: useShell,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            truncated: result.truncated,
            guardVerdict: guardVerdict.action,
            guardRule: guardVerdict.rule,
            guardReason: guardVerdict.reason,
          },
        },
        isGogCommand(gogProbe) ? GOG_COMPRESS_OPTIONS : {},
      );
    },
  };
}
