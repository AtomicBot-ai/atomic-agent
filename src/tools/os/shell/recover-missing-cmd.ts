import type { CompressedToolResult } from "../../../compressor/result-compressor.js";
import { coerceShellArgs } from "./shell-interpretation.js";

/** A command-form call whose `cmd` was read back from its `args`. */
export interface RecoveredShellCmd {
  cmd: string;
  args: string[];
  /** Read from a `["-c", line]` tail: the line runs as a shell command line. */
  shellLine: boolean;
}

/**
 * Inline Python / Node code rather than a shell line. The unknown-argument
 * guard steers models to `args: ["-c", "<script>"]` for interpreters, so a
 * `-c` tail with no `cmd` may be a script whose interpreter was dropped;
 * running it under `sh` would be a wrong guess. Deliberately coarse: a
 * shell line seldom starts a statement this way.
 */
const SCRIPT_CODE_RE =
  /(?:^|[\n;])\s*(?:import\s+[\w.]+|from\s+[\w.]+\s+import\b|print\s*\(|def\s+\w+\s*\(|console\.\w+\s*\(|require\s*\(|process\.\w+\s*[.(\[]|(?:const|let|var)\s+\w+\s*=)/;

export function looksLikeScriptCode(line: string): boolean {
  return SCRIPT_CODE_RE.test(line);
}

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
 *    form), so the guard sees the real binaries. Not on Windows, where
 *    the line was written for `sh` and `cmd.exe` quotes differently, and
 *    not when the line reads as Python / Node code.
 *  - `[program, ...rest]` with a program that is not a flag (`-x`, or
 *    `/x` on Windows): the first token is the program.
 * Anything else is left alone and still refused.
 *
 * The recovered call goes through the same guard and approval as any
 * other: this only fills in the key, it never widens what may run.
 */
export function recoverMissingShellCmd(
  rawArgs: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): RecoveredShellCmd | null {
  const cmd = rawArgs.cmd;
  if (cmd !== undefined && cmd !== null) {
    if (typeof cmd !== "string" || cmd.trim().length > 0) return null;
  }
  const tokens = coerceShellArgs(rawArgs.args);
  if (tokens === null || tokens.length === 0) return null;
  const first = tokens[0]!.trim();
  if (first.length === 0) return null;
  if (first === "-c") {
    if (platform === "win32") return null;
    const line = tokens[1]?.trim() ?? "";
    if (tokens.length !== 2 || line.length === 0) return null;
    if (looksLikeScriptCode(line)) return null;
    return { cmd: line, args: [], shellLine: true };
  }
  if (first.startsWith("-")) return null;
  if (platform === "win32" && first.startsWith("/")) return null;
  return { cmd: first, args: tokens.slice(1), shellLine: false };
}

/**
 * Said after the output of a recovered call (the shell summary keeps
 * the tail of a long output, so a line above it would be cut), so the
 * model sends `cmd` next time instead of relying on the recovery.
 * `ran` is false for a call the guard blocked or that failed before it
 * started: then the notice only says how the call was read.
 */
export function missingCmdNotice(recovered: RecoveredShellCmd, ran: boolean): string {
  const verb = ran ? "ran" : "read";
  const how = recovered.shellLine
    ? `${verb} the \`-c\` line as a shell command line (sh -c): ${JSON.stringify(recovered.cmd)}`
    : `${verb} it as ${JSON.stringify({ cmd: recovered.cmd, args: recovered.args })}`;
  return `os.shell.run: the call had no \`cmd\`; reconstructed from args and ${how}. Next time put the program in \`cmd\` and its arguments in \`args\`.`;
}

/**
 * Marks a result as coming from a recovered call: the notice at the end
 * of the summary and of the full output (what cloud mode shows, via
 * `fullToolResult`), and `details.recoveredMissingCmd` so the
 * recoveries can be counted. Mutated in place; the full output stays
 * non-enumerable, as `retainToolOutput` keeps it.
 */
export function markRecoveredResult(
  result: CompressedToolResult,
  recovered: RecoveredShellCmd,
): CompressedToolResult {
  const ran = "exitCode" in result.details || result.details.detached === true;
  const notice = missingCmdNotice(recovered, ran);
  // compressToolResult defines fullOutput as a fixed property, so build a
  // fresh result (the spread drops the non-enumerable fields) and define them
  // again, the same way retainToolOutput does.
  const marked: CompressedToolResult = {
    ...result,
    summary: `${result.summary}\n${notice}`,
    details: {
      ...result.details,
      recoveredMissingCmd: recovered.shellLine ? "shell_line" : "argv",
    },
  };
  if (result.fullOutput !== undefined) {
    Object.defineProperty(marked, "fullOutput", {
      value: `${result.fullOutput}\n${notice}`,
      enumerable: false,
    });
    Object.defineProperty(marked, "fullOutputTruncated", {
      value: result.fullOutputTruncated === true,
      enumerable: false,
    });
  }
  return marked;
}

/** Keys of the command form a model may have sent beside a missing `cmd`. */
const KEPT_IN_EXAMPLE = ["cwd", "timeoutMs", "keep", "background"] as const;

/**
 * The one-line refusal for a command-form call with no usable `cmd`,
 * with a working example built from the keys the model did send, so
 * the retry keeps its own shape (ATO-1259). A call that arrived with
 * no arguments at all says so: over some providers the arguments are
 * lost on the way, and the model's reasoning then read "the tool is
 * dropping the `cmd` field" and resent the same empty call.
 */
export function missingCmdMessage(rawArgs: Record<string, unknown>): string {
  const example: Record<string, unknown> = { cmd: "git status" };
  for (const key of KEPT_IN_EXAMPLE) {
    if (rawArgs[key] !== undefined && rawArgs[key] !== null) example[key] = rawArgs[key];
  }
  const shown = JSON.stringify(example);
  const keys = Object.keys(rawArgs).filter((key) => rawArgs[key] !== undefined);
  if (keys.length === 0) {
    return `os.shell.run: the call arrived with no arguments, so there was no command to run (if you wrote one, it did not reach the tool; send the whole call again). Put the command line in \`cmd\`, e.g. ${shown} or {"cmd":"git","args":["status"]}.`;
  }
  const got = rawArgs.cmd === undefined ? "no `cmd`" : `\`cmd\` = ${JSON.stringify(rawArgs.cmd)}`;
  return `os.shell.run: \`cmd\` must be a non-empty string (got ${got} with ${keys.map((k) => `\`${k}\``).join(", ")}): put the program or the whole command line in \`cmd\`, e.g. ${shown}, and its arguments, if separate, in \`args\`.`;
}
