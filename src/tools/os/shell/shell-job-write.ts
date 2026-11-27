import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import {
  requireApproval,
  savedRuleDenies,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import {
  checkBrowserBypassLine,
  checkShellCommandGuard,
  type ShellGuardPolicy,
} from "../shell-command-guard/index.js";
import type { GuardVerdict } from "../shell-command-guard/guard-types.js";
import { collect, headOfCommand, unknownJob, type ShellJobCallContext } from "./shell-job-calls.js";
import { readReply, stripTerminalCodes, writeWaitMs } from "./shell-job-reply.js";
import { runShellSecretWrite } from "./shell-job-secret.js";
import { renderShellResult, tailShellOutput } from "./shell-result.js";
import { formatShellElapsed } from "./shell-timeout.js";

/**
 * `{"write": id, "text": "…"}` (ATO-2277): type into a job started
 * with `tty: true`, then return what it printed in reply. Precedent:
 * Codex unified exec `write_stdin`.
 *
 * Typing into a shell or a REPL runs whatever is typed, so every write
 * passes the same pre-exec guard as a command, line by line: a hardline
 * match refuses the write, a dangerous one asks as `shell_dangerous`,
 * anything else not marked safe asks as `shell` (fail-closed: a REPL
 * expression matches no rule and asks). No write is remembered by shape.
 */

/** The longest text one write takes. */
export const WRITE_MAX_CHARS = 4_000;
const REPLY_TAIL_LINES = 60;

export {
  stripTerminalCodes,
  WRITE_DEFAULT_WAIT_MS,
  WRITE_MAX_WAIT_MS,
  WRITE_QUIET_MS,
} from "./shell-job-reply.js";

export interface ShellWriteOptions extends DangerousToolOptions {
  shellPolicy?: ShellGuardPolicy;
}

const SEVERITY: Record<string, number> = { allow: 0, approval_required: 1, block: 3 };

function severity(verdict: GuardVerdict): number {
  if (verdict.action === "approval_required" && verdict.rule.startsWith("dangerous.")) return 2;
  return SEVERITY[verdict.action] ?? 1;
}

/** The strictest guard verdict over the text's lines; `null` for no line. */
export function guardTypedText(
  text: string,
  cwd: string,
  policy?: ShellGuardPolicy,
): GuardVerdict | null {
  let worst: GuardVerdict | null = null;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/);
    let verdict =
      checkBrowserBypassLine(line, cwd) ??
      checkShellCommandGuard({ cmd: tokens[0]!, rawArgs: tokens.slice(1), cwd }, policy);
    // An interactive bash or zsh expands history before it runs a line:
    // `echo !cd:2-5` can become `echo && rm -rf out`. The guard reads the
    // line as typed, so such a line is never taken as safe: the history
    // rule wins over any verdict short of a block or a dangerous.* prompt.
    if (
      verdict.action !== "block" &&
      !verdict.rule.startsWith("dangerous.") &&
      (line.includes("!") || line.startsWith("^"))
    ) {
      verdict = {
        action: "approval_required",
        rule: "typed.history_expansion",
        reason: "a typed line with ! or ^ can expand to an earlier command from the shell's history",
      };
    }
    if (worst === null || severity(verdict) > severity(worst)) worst = verdict;
  }
  return worst;
}

function writeError(id: number, message: string, extra: Record<string, unknown> = {}): CompressedToolResult {
  return compressToolResult({
    tool: "os.shell.run",
    status: "error",
    output: `os.shell.run: ${message}`,
    details: { jobId: id, write: true, ...extra },
  });
}

export async function runShellWrite(
  ctx: ShellJobCallContext,
  options: ShellWriteOptions,
  id: number,
  rawArgs: Record<string, unknown>,
): Promise<CompressedToolResult> {
  const record = ctx.jobs.get(ctx.sessionId, id);
  if (!record) return unknownJob(ctx, id);
  // `secret` (ATO-2486): the person types the value, never the model.
  if (rawArgs.secret !== undefined && rawArgs.secret !== null && rawArgs.secret !== false) {
    if (record.state !== "running") {
      return writeError(id, `job ${id} is no longer running; {"wait": ${id}} collects its output`);
    }
    return runShellSecretWrite(ctx, options, record, rawArgs);
  }
  const eof = rawArgs.eof === true;
  const text = typeof rawArgs.text === "string" ? rawArgs.text : "";
  if (text.length === 0 && !eof) {
    return writeError(id, `write needs \`text\`, e.g. {"write": ${id}, "text": "y\\n"} (end with \\n to press Enter; "eof": true closes the input)`);
  }
  if (text.length > WRITE_MAX_CHARS) return writeError(id, `\`text\` is longer than ${WRITE_MAX_CHARS} characters`);
  if (record.state !== "running") {
    return writeError(id, `job ${id} is no longer running; {"wait": ${id}} collects its output`);
  }
  const verdict = guardTypedText(text, record.facts.cwd, options.shellPolicy);
  if (verdict?.action === "block") {
    return writeError(id, `blocked by shell guard: ${verdict.rule} - ${verdict.reason}`, {
      guardRule: verdict.rule,
    });
  }
  // A line the guard marks safe still stops at a saved deny rule: it
  // goes to the gate, which refuses it (as for a command, ATO-1332).
  const segments = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim().split(/\s+/).filter((t) => t.length > 0))
    .filter((words) => words.length > 0);
  const deniedBySavedRule =
    verdict?.action === "allow" &&
    options.approvalRequired &&
    savedRuleDenies(options.approvals, {
      sessionId: ctx.sessionId,
      tool: "os.shell.run",
      category: "shell",
      commandSegments: segments,
      affectedResources: [record.facts.cwd],
      workdir: record.facts.cwd,
    });
  if (verdict !== null && (verdict.action !== "allow" || deniedBySavedRule)) {
    const dangerous = verdict.rule.startsWith("dangerous.");
    await requireApproval(
      options,
      {
        sessionId: ctx.sessionId,
        tool: "os.shell.run",
        category: dangerous ? "shell_dangerous" : "shell",
        reason: `type into job ${id} (${headOfCommand(record.facts.commandLine)}): ${verdict.reason} in ${record.facts.cwd}`,
        preview: JSON.stringify(text),
        affectedResources: [record.facts.cwd],
        commandSegments: segments,
        workdir: record.facts.cwd,
      },
      ctx.signal,
    );
  }
  const reply = readReply(record, writeWaitMs(rawArgs.timeoutMs), ctx.signal);
  if (text.length > 0 && !record.job.write(text)) {
    return writeError(id, `job ${id} takes no input: start it with {"cmd": …, "tty": true}`);
  }
  if (eof) record.job.endInput();
  const printed = stripTerminalCodes(await reply);
  const notice = `typed ${JSON.stringify(text.length > 80 ? `${text.slice(0, 79)}…` : text)}${eof ? " and closed the input" : ""} into job ${id}; its reply is below. {"write": ${id}, "text": …} types more, {"kill": ${id}} stops it.`;
  if (record.job.exited() !== null) return collect(ctx.jobs, record, [notice]);
  return renderShellResult({
    facts: record.facts,
    status: "ok",
    notices: [notice],
    statusLine: `still running (job ${id}, pid ${record.job.pid ?? "?"}, ${formatShellElapsed(Date.now() - record.job.startedAt)})`,
    body: tailShellOutput(printed, REPLY_TAIL_LINES),
    overflow: "tail",
    details: { detached: true, write: true, jobId: id, keep: record.keep, typedChars: text.length, eof },
  });
}
