import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import type {
  AgentLoopEvent,
  AgentLoopReason,
  RunTurnResult,
} from "../../agent/agent-loop.js";
import {
  countReplacedInputs,
  describeReplacedInput,
  replacedInputsOf,
  type ReplacedInput,
} from "./replaced-inputs.js";
import { FUSION_WORKER_APPROVAL_MARKER } from "./worker-tool-policy.js";

/**
 * What one delegated task produced, as the orchestrator sees it.
 *
 * A worker session is thrown away the moment its turn ends, so this
 * object is the only surviving record. It carries the reply (the work),
 * the status (whether the reply can be trusted as finished), and the
 * shape numbers — steps, tool calls, errors, tokens — that let the
 * orchestrator decide whether to merge, re-delegate, or do the part
 * itself without re-reading a transcript it no longer has.
 */
export type WorkerTaskStatus =
  | "ok"
  | "no_changes"
  | "failed"
  | "cancelled"
  | "needs_orchestrator"
  | "max_steps"
  /**
   * The worker ran out of WALL TIME rather than steps. Set by
   * `runOneTask`, which is the only caller that knows whose clock
   * fired: `classifyWorkerStatus` deliberately keeps `cancelled` ahead
   * of a `time_ceiling` stop cause, because an operator who cancelled a
   * worker that also passed a ceiling cancelled it. Kept apart from
   * `max_steps` because the orchestrator's remedy differs: a task that
   * ran out of steps needs a bigger step budget (or splitting), one that
   * ran out of time needs a longer deadline. Relabelling a timeout as
   * `max_steps` told it to raise the wrong one.
   */
  | "timeout"
  /**
   * The worker never got a server slot: it sat in llama-server's queue
   * behind busy slots and produced no token at all. Not the worker's
   * fault and not a ceiling it hit — a scheduling outcome, so the remedy
   * is a narrower fan-out, not a bigger budget.
   */
  | "queued";

/**
 * The order the head line counts statuses in: what was delivered first,
 * then what was not and why. Fixed so two fan-outs with the same
 * outcome read the same, whichever task finished first.
 */
export const WORKER_STATUS_ORDER: readonly WorkerTaskStatus[] = [
  "ok",
  "no_changes",
  "needs_orchestrator",
  "max_steps",
  "timeout",
  "queued",
  "failed",
  "cancelled",
];

/** Which ceiling ended a worker's loop — see `RunTurnResult.stopCause`. */
export type WorkerStopCause = NonNullable<RunTurnResult["stopCause"]>;

export interface WorkerToolStats {
  calls: number;
  errors: number;
  /**
   * Successful write / edit / patch calls. A task that declared `files`
   * and made none is `no_changes` (`declared-files.ts`), whatever its
   * reply says.
   */
  writes: number;
  byTool: Record<string, number>;
}

/** The calls that change a file. Shell commands can too, but the disk check catches those. */
export const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.restore",
]);

/**
 * How the call as a whole went, for `details.outcome` and the tool
 * result's own status: `all_ok` when every task is `ok`, `all_failed`
 * when every task is `failed` or `cancelled` — the one case the result
 * is `status: "error"` — and `partial` for everything in between.
 */
export type DelegateOutcome = "all_ok" | "partial" | "all_failed";

export function delegateOutcome(
  results: readonly WorkerTaskResult[],
): DelegateOutcome {
  if (results.every((r) => r.status === "ok")) return "all_ok";
  if (results.every((r) => r.status === "failed" || r.status === "cancelled")) {
    return "all_failed";
  }
  return "partial";
}

export interface WorkerTaskResult {
  id: string;
  title: string;
  status: WorkerTaskStatus;
  reply: string;
  stepCount: number;
  durationMs: number;
  /**
   * How long the worker waited between being started and the server's
   * first token, in ms. `null` when no token ever arrived.
   *
   * Recorded because the transcript could not tell two very different
   * failures apart: a worker queued behind busy slots, and a worker whose
   * request never reached the server at all. Both arrived as a task with
   * zero steps and a duration equal to its whole budget, and separating
   * them in the field took four delegations plus reading the
   * llama-server log alongside the trace to see the server had recorded
   * nothing.
   *
   * With this on the row, `durationMs` minus `queueWaitMs` is the time
   * the worker actually had, and a `null` on a fan-out of one points at
   * the daemon rather than at the fan-out's width.
   */
  queueWaitMs?: number | null;
  tools: WorkerToolStats;
  usage?: CompletionUsage;
  /**
   * What went wrong, in the failing layer's own words: the thrown turn,
   * the worker loop's last provider/loop error, or the declared-file
   * check. Rendered on the task's head line.
   */
  error?: string;
  /** What to do about `error`, for a recognised class — `workerFailureHint`. */
  hint?: string;
  /**
   * Non-fatal facts the orchestrator should weigh before merging: a
   * reply written on the forced final step, a declared file the task
   * never touched.
   */
  notes?: string[];
  /**
   * The contract's `checks` attributed to this task, once they ran
   * (`contract-checks.ts`). A failure is also the row's `error`.
   */
  checks?: TaskCheckSummary;
  /**
   * Every pre-existing file this task's writes replaced or shrank (the
   * replace guard's hits, `replaced-inputs.ts`), in call order. The
   * status stands; the row and the head line carry the fact.
   */
  replacedInputs?: ReplacedInput[];
}

export interface TaskCheckSummary {
  total: number;
  failed: number;
  /** The failing checks' verdicts, joined; absent when all passed. */
  detail?: string;
}

/**
 * `checks: 1 of 2 failed — …` / `checks: 2 of 2 passed`. The detail is
 * left off when the row's error already carries it (a task failed BY
 * its checks has `checks: …` as its error), so the verdict reads once.
 */
export function describeChecks(
  checks: TaskCheckSummary,
  cap: number,
  error?: string,
): string {
  if (checks.failed === 0) {
    return `checks: ${checks.total} of ${checks.total} passed`;
  }
  const detail =
    checks.detail === undefined || error?.startsWith("checks: ")
      ? ""
      : ` — ${oneLine(checks.detail, cap)}`;
  return `checks: ${checks.failed} of ${checks.total} failed${detail}`;
}

/**
 * Accumulates one worker turn's observable output from its event hook.
 *
 * The hook is the only channel: `RunTurnResult` gives the reason and
 * the step count but not the reply text, the tool tally, the token
 * usage, or the provider error that killed the turn, and re-deriving
 * them from the returned session would mean walking a transcript that
 * exists purely to be discarded.
 */
export class WorkerRunCollector {
  private replyText = "";
  private approvalRefused = false;
  private calls = 0;
  private errors = 0;
  private writes = 0;
  private readonly byTool: Record<string, number> = {};
  private usage: CompletionUsage | undefined;
  private lastLoopError: string | undefined;
  private lastWaitReason: string | undefined;
  /** The last few tool results, one line each — what a hand-back reports. */
  private readonly recent: string[] = [];
  private readonly replaced: ReplacedInput[] = [];

  /** Feed one `AgentLoopEvent` from the worker turn's hook. */
  observe(event: AgentLoopEvent): void {
    if (event.type === "loop_failed") {
      // A cancelled turn reports its abort through the same event; that
      // is not a cause, and the status already says `cancelled`.
      if (event.category !== "cancelled") {
        this.lastLoopError = event.error.message;
      }
      return;
    }
    if (event.type === "provider_waiting") {
      // A worker that parks on a dead server and is then cut off by its
      // time limit never reaches `loop_failed`: this is the only record
      // of why its 590 seconds produced nothing.
      this.lastWaitReason = event.reason;
      return;
    }
    if (event.type === "provider_recovered") {
      this.lastWaitReason = undefined;
      return;
    }
    if (event.type === "credit_exhausted") {
      // The loop pauses the worker's turn resumable, but a worker is
      // never resumed: for the orchestrator this is a failed task with
      // the reason, not a stopped one.
      this.lastLoopError = `"${event.provider}" is out of credit: ${event.message}`;
      return;
    }
    if (event.type !== "llm_event") return;
    const inner = event.event;
    if (inner.type === "assistant_reply") {
      // Last writer wins: an auto-continued turn can emit more than one
      // reply, and the last is the one that ended the work. A progress
      // note (a reply the worker batched with work) is not a report.
      if (inner.progressNote !== true) this.replyText = inner.text;
      return;
    }
    if (inner.type === "tool_call_executed") {
      const result = inner.result;
      this.calls += 1;
      this.byTool[result.tool] = (this.byTool[result.tool] ?? 0) + 1;
      if (result.status === "error") this.errors += 1;
      else if (FILE_WRITING_TOOLS.has(result.tool)) this.writes += 1;
      if (resultCarriesApprovalRefusal(result.summary, result.details)) {
        this.approvalRefused = true;
      }
      // The guard's hit is in the result's details whatever its status:
      // the write landed before the guard spoke.
      this.replaced.push(...replacedInputsOf(result.tool, result.details));
      this.recent.push(
        `${result.tool} ${result.status}: ${oneLine(result.summary, FINDING_CHARS)}`,
      );
      if (this.recent.length > FINDINGS_KEPT) this.recent.shift();
      return;
    }
    if (inner.type === "llm_completed" && inner.completion.usage) {
      const next = inner.completion.usage;
      const prev = this.usage;
      this.usage =
        prev === undefined
          ? { ...next }
          : {
              promptTokens: prev.promptTokens + next.promptTokens,
              completionTokens: prev.completionTokens + next.completionTokens,
              totalTokens: prev.totalTokens + next.totalTokens,
            };
    }
  }

  /**
   * What the worker saw before it was handed back: the tool tally and
   * its last few results. The orchestrator re-briefs from this rather
   * than from nothing.
   */
  findings(): string {
    const tally = Object.entries(this.byTool)
      .map(([tool, n]) => `${tool}×${n}`)
      .join(", ");
    const parts = [
      this.calls === 0 ? "no tool calls" : `${this.calls} tool calls (${tally})`,
      ...(this.recent.length > 0 ? [`last results: ${this.recent.join(" | ")}`] : []),
      ...(this.replyText.length > 0
        ? [`partial reply: ${oneLine(this.replyText, FINDING_CHARS)}`]
        : []),
    ];
    return parts.join("; ");
  }

  /** The worker loop's own account of why it stopped working, if any. */
  private failureMessage(): string | undefined {
    if (this.lastLoopError !== undefined) return this.lastLoopError;
    if (this.lastWaitReason !== undefined) {
      return `the provider stopped answering: ${this.lastWaitReason}`;
    }
    return undefined;
  }

  /**
   * Fold the loop's own outcome in and produce the result row.
   *
   * A refusal outranks a clean `reply`: the worker did finish, but it
   * finished by handing an action back, and the orchestrator must not
   * read that as done. It does NOT outrank `failed` / `cancelled` —
   * those say the reply is not even complete.
   *
   * `error` from the caller (a thrown turn, the session's stored error)
   * wins over the collected one; either way a recognised failure class
   * gets its remediation `hint`.
   */
  finish(input: {
    id: string;
    title: string;
    reason: AgentLoopReason | null;
    stepCount: number;
    durationMs: number;
    error?: string;
    stopCause?: WorkerStopCause;
  }): WorkerTaskResult {
    const status = classifyWorkerStatus(
      input.reason,
      this.approvalRefused,
      input.stopCause,
    );
    const error =
      input.error ?? (status === "ok" ? undefined : this.failureMessage());
    const hint = error === undefined ? undefined : workerFailureHint(error);
    const notes =
      input.stopCause !== undefined &&
      status !== "failed" &&
      status !== "cancelled"
        ? [stopCauseNote(input.stopCause, input.stepCount)]
        : [];
    return {
      id: input.id,
      title: input.title,
      status,
      reply: this.replyText,
      stepCount: input.stepCount,
      durationMs: input.durationMs,
      tools: {
        calls: this.calls,
        errors: this.errors,
        writes: this.writes,
        byTool: { ...this.byTool },
      },
      ...(this.usage ? { usage: this.usage } : {}),
      ...(error === undefined ? {} : { error }),
      ...(hint === undefined ? {} : { hint }),
      ...(notes.length === 0 ? {} : { notes }),
      ...(this.replaced.length === 0
        ? {}
        : { replacedInputs: [...this.replaced] }),
    };
  }
}

function stopCauseNote(cause: WorkerStopCause, stepCount: number): string {
  if (cause === "credit_exhausted") {
    return "stopped because the provider is out of credit";
  }
  if (cause === "time_ceiling") {
    return "stopped at its time limit; any reply was written on the forced final step and may describe work that was not done";
  }
  if (cause === "no_progress") {
    return "stopped after a whole leg of steps made no progress";
  }
  return `stopped at its step limit (${stepCount} steps); the reply was written on the forced final step and may describe work that was not done`;
}

/** Whether a tool result is the worker approval refusal. */
export function resultCarriesApprovalRefusal(
  summary: string,
  details: Record<string, unknown>,
): boolean {
  if (summary.includes(FUSION_WORKER_APPROVAL_MARKER)) return true;
  const reason = details.deniedReason ?? details.reason;
  return (
    typeof reason === "string" && reason.includes(FUSION_WORKER_APPROVAL_MARKER)
  );
}

/**
 * Map a loop reason (or a thrown turn) onto a worker status.
 *
 * `stopCause` is the loop saying a ceiling ended the task. A `reply` on
 * the forced final step is exactly how a worker at 40/40 steps wrote
 * "the step limit was reached before the file write could be executed"
 * and was reported `ok`: the model closed the turn, but only because it
 * was offered nothing else.
 */
export function classifyWorkerStatus(
  reason: AgentLoopReason | null,
  approvalRefused: boolean,
  stopCause?: WorkerStopCause,
): WorkerTaskStatus {
  if (reason === null || reason === "failed") return "failed";
  if (reason === "cancelled") return "cancelled";
  // Out of credit is not a ceiling the worker ran into; nothing it
  // wrote after that point exists, and re-delegating cannot help.
  if (stopCause === "credit_exhausted") return "failed";
  if (approvalRefused) return "needs_orchestrator";
  if (reason === "max_steps" || stopCause !== undefined) return "max_steps";
  return "ok";
}

/**
 * What a `queued` worker reports. It produced nothing, so there is no
 * reply to summarise; the remedy belongs to the fan-out's width, not to
 * the task, and saying so is the whole content of the row.
 */
export const WORKER_QUEUED_NOTE =
  "produced no token at all: the request was sent and nothing came back";

/**
 * Two hints, because the same silence means opposite things.
 *
 * With other workers running alongside, a worker that never got a token
 * was queued behind them and the fan-out is too wide. ALONE on the leg
 * it is the opposite: there was nothing to queue behind, so a silent
 * worker means the request never reached the server or the server never
 * answered it — a client or daemon fault, and telling the orchestrator
 * to "use fewer workers" there sends it to narrow a fan-out of one.
 *
 * Measured: four solo delegations died at 45 minutes with zero tool
 * calls while the llama-server log recorded nothing at all for the whole
 * window, the server having gone silent to this client after an earlier
 * generation was cancelled. A restart cleared it.
 */
export const WORKER_HINT_QUEUED =
  "the local server had no free slot: run fewer workers at once, or split the fan-out into smaller waves";
export const WORKER_HINT_UNSERVED =
  "this worker ran alone and still got no token, so the local server never answered it: check that the daemon is alive and restart it before re-delegating — a narrower fan-out will not help";

export const WORKER_HINT_CONTEXT =
  "the local server ran out of context: use fewer workers at once or shorter briefs";
export const WORKER_HINT_SATURATED =
  "the local server was saturated: fewer parallel workers";
export const WORKER_HINT_QUOTA =
  "provider credit/quota exhausted — retrying will not help";
/**
 * The client's `/slots` watchdog proved the server answers nothing at
 * all (`first-token-unreachable`). That is evidence `WORKER_HINT_QUEUED`
 * and `WORKER_HINT_SATURATED` do not have: the server is not full, it is
 * gone, and narrowing the fan-out on a dead daemon wastes another wave.
 */
export const WORKER_HINT_UNREACHABLE =
  "the local server stopped answering entirely: restart the daemon before re-delegating — fewer workers will not help";

const CONTEXT_EXCEEDED =
  /context size has been exceeded|ran out of context|exceeds? the (?:available )?context|context (?:size|length|window) (?:exceeded|was exceeded)/i;
const SERVER_SATURATED =
  /no first token|first[- ]token timeout|sent no data for \d+\s*ms|idle timeout/i;
const SERVER_UNREACHABLE = /stopped answering GET \/slots|it is unreachable/i;
const CREDIT_OR_QUOTA =
  /\b402\b|\b429\b|payment required|insufficient (?:credits?|funds|balance|quota)|out of credits?|quota (?:exceeded|exhausted)|exceeded (?:your|the) (?:current )?quota|rate[- ]limit|too many requests/i;

/**
 * A short remediation for a worker failure the orchestrator (or the
 * operator reading its reply) can act on, or `undefined` when the
 * message is not one of the recognised classes.
 *
 * Matched on the message text because that is what survives: the
 * llama-server body (`Context size has been exceeded`), atag's own
 * transport deadlines (`sent no first token within …`), and a cloud
 * gateway's 402 / 429.
 */
export function workerFailureHint(message: string): string | undefined {
  // Before the saturation arm: an unreachable server is the strictly
  // better-evidenced diagnosis, and "use fewer workers" is the wrong
  // advice for a daemon that is not answering anybody.
  if (SERVER_UNREACHABLE.test(message)) return WORKER_HINT_UNREACHABLE;
  if (SERVER_SATURATED.test(message)) return WORKER_HINT_SATURATED;
  if (CONTEXT_EXCEEDED.test(message)) return WORKER_HINT_CONTEXT;
  if (CREDIT_OR_QUOTA.test(message)) return WORKER_HINT_QUOTA;
  return undefined;
}

const NO_REPLY = "(the worker produced no reply)";

/** How many tool results a hand-back's findings keep, and how much of each. */
const FINDINGS_KEPT = 6;
const FINDING_CHARS = 160;

/** How much of an error the head line carries; the rest is noise. */
const ERROR_HEAD_CHARS = 400;

/**
 * Render the results as the tool's `summary`.
 *
 * A status table first: one line per task with its status, error head
 * and notes. A reader that sees only the start of this result — a prompt
 * renders tool results through a character cap — still sees every task's
 * outcome and warnings. Without it a seven-task fan-out showed its first
 * blocks, and the one task that had changed nothing (its note said so, at
 * the end) passed for `ok`.
 *
 * Then two caps, not one. The per-task cap keeps a single verbose worker
 * from crowding its siblings out of the orchestrator's view — the
 * whole point of the fan-out is that it sees all the parts — and the
 * total cap keeps the block inside the step's tool-result budget.
 * Truncation is always announced inline: a silently clipped result is
 * one the orchestrator merges as if it were whole.
 */
export function formatDelegateOutput(
  results: readonly WorkerTaskResult[],
  charCap: number,
  extra: DelegateOutputExtras = {},
): string {
  if (results.length === 0) return "(no tasks were run)";
  const table = renderStatusTable(results, extra);
  const room = Math.max(0, charCap - table.length - 4);
  const perTask = Math.max(200, Math.floor(room / results.length));
  const blocks = results.map((r) => renderBlock(r, perTask));
  const joined = [table, ...blocks].join("\n\n");
  if (joined.length <= charCap) return joined;
  return `${joined.slice(0, Math.max(0, charCap - 15))}\n… [truncated]`;
}

/** How much of an error or a note one status-table line carries. */
const TABLE_DETAIL_CHARS = 160;

/** USD per million tokens, as the model catalogue / `userModels[].pricing` state it. */
export interface WorkerPricing {
  input: number;
  output: number;
}

/** What a fan-out cost on its worker leg, for the status table header. */
export interface FanoutSpend {
  usd: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Σ over the tasks' usage at `pricing`, the same arithmetic as the
 * turn cost line (`turn-usage-meter.ts`). Tasks with no usage (a turn
 * that died before its first completion) contribute nothing.
 */
export function fanoutSpend(
  results: readonly WorkerTaskResult[],
  pricing: WorkerPricing,
  model: string,
): FanoutSpend {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const r of results) {
    if (r.usage === undefined) continue;
    promptTokens += r.usage.promptTokens;
    completionTokens += r.usage.completionTokens;
  }
  const usd =
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output;
  return { usd, model, promptTokens, completionTokens };
}

function formatUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** What the status table carries beyond the rows themselves. */
export interface DelegateOutputExtras {
  /** The contract's verdict (`renderContractLine`), when the fan-out had one. */
  contractLine?: string;
  /** The fan-out's priced worker spend, when the worker model is priced. */
  spend?: FanoutSpend | null;
  /**
   * The wave plan the contract's requires imposed (`contract-waves.ts`),
   * task ids wave by wave. Absent when the contract ordered nothing —
   * the head line then reads exactly as before.
   */
  waves?: readonly (readonly string[])[];
}

/** `analyze → organize, index` — waves in order, each wave's tasks together. */
export function describeWaves(
  waves: readonly (readonly string[])[],
): string {
  return waves.map((wave) => wave.join(", ")).join(" → ");
}

/**
 * The head line (with the replaced-input count and the bill, when there
 * are any), the contract's verdict when there is one, then one line per
 * task. The contract line sits second because it is the one cross-task
 * fact: a missing provide is a hole between parts, not a property of
 * any single row. A replaced input is first on its row, ahead of the
 * error and the notes: the status stands, but a user's file is gone
 * until someone restores it, and that outranks why the task stopped.
 */
function renderStatusTable(
  results: readonly WorkerTaskResult[],
  extra: DelegateOutputExtras,
): string {
  const { contractLine } = extra;
  const spend = extra.spend ?? null;
  const counts = new Map<WorkerTaskStatus, number>();
  for (const r of results) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
  const tally = WORKER_STATUS_ORDER.filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join(", ");
  // The bill, on the head line, where a capped read still sees it: a
  // fan-out whose two workers wrote nothing cost $2.29 and nothing said so.
  const cost =
    spend === null
      ? ""
      : ` — cloud spend ${formatUsd(spend.usd)} on ${spend.model} (${spend.promptTokens.toLocaleString("en-US")} in / ${spend.completionTokens.toLocaleString("en-US")} out)`;
  const replacedCount = countReplacedInputs(results);
  const replaced = replacedCount === null ? "" : ` — ${replacedCount}`;
  // The order the contract imposed, on the head line: which tasks
  // waited for which, so a report of "no_changes" on a later wave reads
  // against what its provider delivered.
  const waves =
    extra.waves === undefined
      ? ""
      : ` in ${extra.waves.length} wave${extra.waves.length === 1 ? "" : "s"} (${describeWaves(extra.waves)})`;
  const lines = results.map((r) =>
    [
      `- [${r.id}] ${r.status} — ${r.title}`,
      ...(r.replacedInputs ?? []).map((input) =>
        oneLine(describeReplacedInput(input), TABLE_DETAIL_CHARS),
      ),
      ...(r.error ? [`error: ${oneLine(r.error, TABLE_DETAIL_CHARS)}`] : []),
      ...(r.checks ? [describeChecks(r.checks, TABLE_DETAIL_CHARS, r.error)] : []),
      ...(r.notes ?? []).map((note) => oneLine(note, TABLE_DETAIL_CHARS)),
    ].join(" — "),
  );
  return [
    `${results.length} task${results.length === 1 ? "" : "s"}${waves}: ${tally}${replaced}${cost}`,
    ...(contractLine === undefined ? [] : [contractLine]),
    ...lines,
  ].join("\n");
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * The diagnosis goes ABOVE the reply: the error on the head line, then
 * the replaced inputs, the hint and notes. A worker that died on its
 * provider has no reply worth the space, and one that claimed work it
 * did not do has a reply that must not be read first.
 */
function renderBlock(result: WorkerTaskResult, perTaskCap: number): string {
  const head =
    `[${result.id}] ${result.status} — ${result.title} ` +
    `(${result.stepCount} steps, ${Math.round(result.durationMs / 1000)}s, ` +
    `${result.tools.calls} tool calls, ${result.tools.errors} errors)` +
    (result.error ? ` — error: ${oneLine(result.error, ERROR_HEAD_CHARS)}` : "");
  const diagnosis = [
    ...(result.replacedInputs ?? []).map(describeReplacedInput),
    ...(result.hint ? [`hint: ${result.hint}`] : []),
    ...(result.checks
      ? [describeChecks(result.checks, ERROR_HEAD_CHARS, result.error)]
      : []),
    ...(result.notes ?? []).map((note) => `note: ${note}`),
  ];
  const used = [head, ...diagnosis].join("\n").length;
  const bodyCap = Math.max(100, perTaskCap - used);
  const body = result.reply.length > 0 ? result.reply : NO_REPLY;
  const clipped =
    body.length > bodyCap
      ? `${body.slice(0, Math.max(0, bodyCap - 15))}\n… [truncated]`
      : body;
  return [head, ...diagnosis, clipped].join("\n");
}
