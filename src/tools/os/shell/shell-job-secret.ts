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
import { awaitJobExit } from "../../../sandbox/command-job.js";
import { headOfCommand, type ShellJobCallContext } from "./shell-job-calls.js";
import type { ShellJobRecord } from "./shell-jobs.js";
import { renderShellExit, renderShellResult, tailShellOutput } from "./shell-result.js";
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
 * Only a person answers (`shell_secret_input` is never auto-approved). A
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
 * so every result of the session's shell calls (`{cmd}` and every job
 * form, `shell.ts`) also passes through {@link hideTypedSecrets}: a job
 * that echoed the value and exited, a later `{"wait": id}`, or a new
 * command that prints it never shows it. Process memory only.
 *
 * Values shorter than {@link SESSION_MASK_MIN_CHARS} are not kept here:
 * hiding `1` or `ab` everywhere would blank job ids, exit codes and
 * words. They are hidden in the reply to the write that typed them only.
 */
const typedBySession = new Map<string, Set<string>>();

/** The shortest value hidden session-wide; shorter ones only in their own reply. */
export const SESSION_MASK_MIN_CHARS = 4;

export function rememberTypedSecret(sessionId: string, value: string): void {
  if (value.length < SESSION_MASK_MIN_CHARS) return;
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

/** The marker `compressToolResult` puts where it cut the summary. */
const SUMMARY_CUT_MARKER = "… [truncated]";
/** Shortest piece of a value worth hiding next to a cut. */
const MIN_CUT_FRAGMENT = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with every whole value replaced in one pass (longest first, so
 * a value containing another goes whole and a marker is never re-cut),
 * then a piece of a value left at a summary cut: the start of one just
 * before the marker, the end of one just after it. The cut runs before
 * this (`compressToolResult`), so a tail cut inside `letmein` leaves
 * `tmein` behind the marker.
 */
export function hideValues(text: string, values: readonly string[]): string {
  if (values.length === 0 || text.length === 0) return text;
  const sorted = [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return text;
  let out = text.replace(new RegExp(sorted.map(escapeRegExp).join("|"), "g"), HIDDEN);
  if (!out.includes(SUMMARY_CUT_MARKER)) return out;
  const parts = out.split(SUMMARY_CUT_MARKER);
  for (let k = 0; k < parts.length; k += 1) {
    let part = parts[k]!;
    for (const value of sorted) {
      if (k < parts.length - 1) {
        // the start of a value, cut off before the marker (its own line break kept)
        const lead = part.endsWith("\n") ? "\n" : "";
        const body = lead ? part.slice(0, -1) : part;
        for (let n = value.length - 1; n >= MIN_CUT_FRAGMENT; n -= 1) {
          if (body.endsWith(value.slice(0, n))) {
            part = `${body.slice(0, body.length - n)}${HIDDEN}${lead}`;
            break;
          }
        }
      }
      if (k > 0) {
        const lead = part.startsWith("\n") ? "\n" : "";
        const body = lead ? part.slice(1) : part;
        for (let n = value.length - 1; n >= MIN_CUT_FRAGMENT; n -= 1) {
          if (body.startsWith(value.slice(value.length - n))) {
            part = `${lead}${HIDDEN}${body.slice(n)}`;
            break;
          }
        }
      }
    }
    parts[k] = part;
  }
  out = parts.join(SUMMARY_CUT_MARKER);
  return out;
}

/** Every string inside `value` hidden; numbers, booleans and keys kept. */
function hideLeaves(value: unknown, values: readonly string[]): unknown {
  if (typeof value === "string") return hideValues(value, values);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = hideLeaves(item, values);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = hideLeaves(item, values);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * `result` with `values` hidden in its summary, full output and the
 * strings of its details; `result` itself when there was nothing to hide.
 */
export function hideValuesInResult(result: CompressedToolResult, values: readonly string[]): CompressedToolResult {
  if (values.length === 0) return result;
  const summary = hideValues(result.summary, values);
  const full = result.fullOutput === undefined ? undefined : hideValues(result.fullOutput, values);
  const details = hideLeaves(result.details, values) as Record<string, unknown>;
  if (summary === result.summary && full === result.fullOutput && details === result.details) return result;
  const hidden: CompressedToolResult = { ...result, summary, details };
  // Non-enumerable, like `compressToolResult` sets them; the spread drops them.
  if (full !== undefined) {
    Object.defineProperty(hidden, "fullOutput", { value: full, enumerable: false });
    Object.defineProperty(hidden, "fullOutputTruncated", { value: result.fullOutputTruncated, enumerable: false });
  }
  return hidden;
}

function typedValues(sessionId: string): string[] {
  return [...(typedBySession.get(sessionId) ?? [])];
}

/** `result` with every value typed into this session's jobs hidden. */
export function hideTypedSecrets(sessionId: string, result: CompressedToolResult): CompressedToolResult {
  return hideValuesInResult(result, typedValues(sessionId));
}

/**
 * `text` with every value typed into this session's jobs hidden. For
 * text built from a job's output outside a tool result: a monitor's wake
 * notice, a steer, a task message (#2040).
 */
export function hideTypedSecretsText(sessionId: string, text: string): string {
  return hideValues(text, typedValues(sessionId));
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
  // here, hidden before it is compressed (as the reply below), whatever
  // the value's length. Not `collect`: its notices name the job, and a
  // short value must not blank them.
  if (record.job.exited() !== null) {
    const exit = await awaitJobExit(record.job);
    ctx.jobs.drop(record);
    const out = record.job.output();
    return renderShellExit(
      record.facts,
      exit,
      { ...out, stdout: hideValue(out.stdout, value), stderr: hideValue(out.stderr, value) },
      { jobId: id, notices: [notice] },
    );
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
