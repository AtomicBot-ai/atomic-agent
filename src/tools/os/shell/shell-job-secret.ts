import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import {
  checkShellSecretValue,
  describeShellSecretPrompt,
  normalizeShellSecretLabel,
  SHELL_SECRET_CATEGORY,
  SHELL_SECRET_PROMPT_LINE_MAX,
  type ShellSecretPrompt,
} from "../../../approval/shell-secret.js";
import { rememberResolvedSecret } from "../../../sandbox/resolved-secret-values.js";
import { collect, headOfCommand, type ShellJobCallContext } from "./shell-job-calls.js";
import type { ShellJobRecord } from "./shell-jobs.js";
import { renderShellResult, tailShellOutput } from "./shell-result.js";
import { formatShellElapsed } from "./shell-timeout.js";
import { readReply, stripTerminalCodes, writeWaitMs } from "./shell-job-reply.js";
import type { ShellWriteOptions } from "./shell-job-write.js";

/**
 * `{"write": id, "secret": "sudo password"}` (ATO-2486): the program in
 * an interactive job asks for a password; the person types it and the
 * value goes straight into the job's input. The model names what is
 * asked and gets back only that it was typed and what the program
 * printed next: never the value, which is also added to the values
 * masked in every tool result and trace (`resolved-secret-values.ts`).
 *
 * Only a person answers (`shell_secret` is never auto-approved). A
 * surface that cannot take a secret (a chat bridge) approves without a
 * value, and the result says nothing was typed. Precedent: `sudo`'s
 * prompt, and Claude Code / Codex handing a password step to the person.
 */

const REPLY_TAIL_LINES = 60;
const HIDDEN = "[secret hidden]";

function secretError(id: number, message: string, extra: Record<string, unknown> = {}): CompressedToolResult {
  return compressToolResult({
    tool: "os.shell.run",
    status: "error",
    output: `os.shell.run: ${message}`,
    details: { jobId: id, write: true, secret: true, ...extra },
  });
}

function notTyped(id: number, label: string, why: string): CompressedToolResult {
  return compressToolResult({
    tool: "os.shell.run",
    status: "ok",
    output:
      `os.shell.run: nothing was typed into job ${id}: ${why}. ` +
      `Do not type ${label} yourself or ask for it in the chat. Ask the user to type it ` +
      `(Atomic Agent terminal or desktop window), or {"kill": ${id}} and go on another way.`,
    details: { jobId: id, write: true, secret: true, typed: false },
  });
}

/** The job's last line of output: the prompt the person is answering. */
export function lastPromptLine(record: ShellJobRecord): string {
  const out = record.job.output();
  const lines = stripTerminalCodes(`${out.stdout}\n${out.stderr}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1) ?? "";
  return last.length > SHELL_SECRET_PROMPT_LINE_MAX
    ? `${last.slice(0, SHELL_SECRET_PROMPT_LINE_MAX - 1)}…`
    : last;
}

/** `text` with every occurrence of `value` replaced. */
export function hideValue(text: string, value: string): string {
  return value.length === 0 ? text : text.split(value).join(HIDDEN);
}

/**
 * Values the person typed into this session's jobs. The global masking
 * (`resolved-secret-values.ts`) skips short or plain values (`letmein`),
 * so every job result of the session is also passed through
 * {@link hideTypedSecrets}: a job that echoed the value and exited, or a
 * later `{"wait": id}`, never shows it. Process memory only.
 */
const typedBySession = new Map<string, Set<string>>();

export function rememberTypedSecret(sessionId: string, value: string): void {
  if (value.length === 0) return;
  let values = typedBySession.get(sessionId);
  if (!values) {
    values = new Set();
    typedBySession.set(sessionId, values);
  }
  values.add(value);
}

/** Test seam: forget every typed value. */
export function resetTypedSecrets(): void {
  typedBySession.clear();
}

function hideAll(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) out = hideValue(out, value);
  return out;
}

/**
 * `result` with every value typed into this session's jobs replaced in
 * its summary, full output and details; `result` itself when there was
 * nothing to hide.
 */
export function hideTypedSecrets(sessionId: string, result: CompressedToolResult): CompressedToolResult {
  const known = typedBySession.get(sessionId);
  if (!known || known.size === 0) return result;
  // Longest first, so a value containing another is replaced whole.
  const values = [...known].sort((a, b) => b.length - a.length);
  const summary = hideAll(result.summary, values);
  const full = result.fullOutput === undefined ? undefined : hideAll(result.fullOutput, values);
  const detailsJson = JSON.stringify(result.details);
  const hiddenJson = hideAll(detailsJson, values.map((v) => JSON.stringify(v).slice(1, -1)));
  if (summary === result.summary && full === result.fullOutput && hiddenJson === detailsJson) return result;
  const hidden: CompressedToolResult = {
    ...result,
    summary,
    details: hiddenJson === detailsJson ? result.details : (JSON.parse(hiddenJson) as Record<string, unknown>),
  };
  // Non-enumerable, like `compressToolResult` sets them; the spread drops them.
  if (full !== undefined) {
    Object.defineProperty(hidden, "fullOutput", { value: full, enumerable: false });
    Object.defineProperty(hidden, "fullOutputTruncated", { value: result.fullOutputTruncated, enumerable: false });
  }
  return hidden;
}

export async function runShellSecretWrite(
  ctx: ShellJobCallContext,
  options: ShellWriteOptions,
  record: ShellJobRecord,
  rawArgs: Record<string, unknown>,
): Promise<CompressedToolResult> {
  const id = record.id;
  if (typeof rawArgs.text === "string" && rawArgs.text.length > 0) {
    return secretError(
      id,
      `\`secret\` replaces \`text\`: the user types the value. Send other input in a write of its own, e.g. {"write": ${id}, "secret": "sudo password"}`,
    );
  }
  const label = normalizeShellSecretLabel(rawArgs.secret);
  const prompt: ShellSecretPrompt = {
    jobId: id,
    label,
    commandLine: headOfCommand(record.facts.commandLine, 120),
    promptLine: lastPromptLine(record),
  };
  const decision = await options.approvals.request(
    {
      sessionId: ctx.sessionId,
      tool: "os.shell.run",
      category: SHELL_SECRET_CATEGORY,
      reason: `job ${id} (${headOfCommand(record.facts.commandLine)}) asks for ${label}: type it here, the agent will not see it`,
      preview: describeShellSecretPrompt(prompt),
      affectedResources: [record.facts.cwd],
      workdir: record.facts.cwd,
      secretInput: prompt,
    },
    { signal: ctx.signal },
  );
  if (!decision.approved) {
    const why =
      decision.automatic === true && decision.declinedEarlier !== true
        ? "nobody could be asked right now"
        : "the user declined";
    return notTyped(id, label, why);
  }
  const checked = checkShellSecretValue(decision.secret);
  if (!checked.ok) {
    // Approved where no value can be typed (a chat bridge, an old client).
    return notTyped(id, label, decision.secret === undefined ? "no value came with the answer" : checked.reason);
  }
  if (record.state !== "running" || record.job.exited() !== null) {
    return secretError(id, `job ${id} ended before the secret could be typed; {"wait": ${id}} collects its output`);
  }
  const value = checked.value;
  // Masked from here on in every tool result and trace of this process
  // (strong-looking values), and in every job result of this session
  // (any value, `hideTypedSecrets`).
  rememberResolvedSecret(`job ${id} ${label}`, value);
  rememberTypedSecret(ctx.sessionId, value);
  const reply = readReply(record, writeWaitMs(rawArgs.timeoutMs), ctx.signal);
  if (!record.job.write(`${value}\n`)) {
    return secretError(id, `job ${id} takes no input: start it with {"cmd": …, "tty": true}`);
  }
  // A terminal does not echo a password prompt; a program that prints
  // the value anyway still does not show it here.
  const printed = hideValue(stripTerminalCodes(await reply), value);
  const notice = `the user typed ${label} into job ${id} (hidden from you); its reply is below. {"write": ${id}, "text": …} types more, {"kill": ${id}} stops it.`;
  // A job that echoed the value and exited: its whole output is rendered
  // here, so it is hidden like the reply.
  if (record.job.exited() !== null) {
    return hideTypedSecrets(ctx.sessionId, await collect(ctx.jobs, record, [notice]));
  }
  return renderShellResult({
    facts: record.facts,
    status: "ok",
    notices: [notice],
    statusLine: `still running (job ${id}, pid ${record.job.pid ?? "?"}, ${formatShellElapsed(Date.now() - record.job.startedAt)})`,
    body: tailShellOutput(printed, REPLY_TAIL_LINES),
    overflow: "tail",
    details: { detached: true, write: true, secret: true, typed: true, jobId: id, keep: record.keep },
  });
}
