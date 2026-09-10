import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import type {
  AgentLoopEvent,
  AgentLoopReason,
} from "../../agent/agent-loop.js";
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
  "ok" | "failed" | "cancelled" | "needs_orchestrator" | "max_steps";

export interface WorkerToolStats {
  calls: number;
  errors: number;
  byTool: Record<string, number>;
}

export interface WorkerTaskResult {
  id: string;
  title: string;
  status: WorkerTaskStatus;
  reply: string;
  stepCount: number;
  durationMs: number;
  tools: WorkerToolStats;
  usage?: CompletionUsage;
  error?: string;
}

/**
 * Accumulates one worker turn's observable output from its event hook.
 *
 * The hook is the only channel: `RunTurnResult` gives the reason and
 * the step count but not the reply text, the tool tally, or the token
 * usage, and re-deriving them from the returned session would mean
 * walking a transcript that exists purely to be discarded.
 */
export class WorkerRunCollector {
  private replyText = "";
  private approvalRefused = false;
  private calls = 0;
  private errors = 0;
  private readonly byTool: Record<string, number> = {};
  private usage: CompletionUsage | undefined;

  /** Feed one `AgentLoopEvent` from the worker turn's hook. */
  observe(event: AgentLoopEvent): void {
    if (event.type !== "llm_event") return;
    const inner = event.event;
    if (inner.type === "assistant_reply") {
      // Last writer wins: an auto-continued turn can emit more than one
      // reply, and the last is the one that ended the work.
      this.replyText = inner.text;
      return;
    }
    if (inner.type === "tool_call_executed") {
      const result = inner.result;
      this.calls += 1;
      this.byTool[result.tool] = (this.byTool[result.tool] ?? 0) + 1;
      if (result.status === "error") this.errors += 1;
      if (resultCarriesApprovalRefusal(result.summary, result.details)) {
        this.approvalRefused = true;
      }
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
   * Fold the loop's own outcome in and produce the result row.
   *
   * A refusal outranks a clean `reply`: the worker did finish, but it
   * finished by handing an action back, and the orchestrator must not
   * read that as done. It does NOT outrank `failed` / `cancelled` —
   * those say the reply is not even complete.
   */
  finish(input: {
    id: string;
    title: string;
    reason: AgentLoopReason | null;
    stepCount: number;
    durationMs: number;
    error?: string;
  }): WorkerTaskResult {
    const status = classifyWorkerStatus(input.reason, this.approvalRefused);
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
        byTool: { ...this.byTool },
      },
      ...(this.usage ? { usage: this.usage } : {}),
      ...(input.error === undefined ? {} : { error: input.error }),
    };
  }
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

/** Map a loop reason (or a thrown turn) onto a worker status. */
export function classifyWorkerStatus(
  reason: AgentLoopReason | null,
  approvalRefused: boolean,
): WorkerTaskStatus {
  if (reason === null || reason === "failed") return "failed";
  if (reason === "cancelled") return "cancelled";
  if (approvalRefused) return "needs_orchestrator";
  if (reason === "max_steps") return "max_steps";
  return "ok";
}

const NO_REPLY = "(the worker produced no reply)";

/**
 * Render the results as the tool's `summary`.
 *
 * Two caps, not one. The per-task cap keeps a single verbose worker
 * from crowding its siblings out of the orchestrator's view — the
 * whole point of the fan-out is that it sees all the parts — and the
 * total cap keeps the block inside the step's tool-result budget.
 * Truncation is always announced inline: a silently clipped result is
 * one the orchestrator merges as if it were whole.
 */
export function formatDelegateOutput(
  results: readonly WorkerTaskResult[],
  charCap: number,
): string {
  if (results.length === 0) return "(no tasks were run)";
  const perTask = Math.max(200, Math.floor(charCap / results.length));
  const blocks = results.map((r) => renderBlock(r, perTask));
  const joined = blocks.join("\n\n");
  if (joined.length <= charCap) return joined;
  return `${joined.slice(0, Math.max(0, charCap - 15))}\n… [truncated]`;
}

function renderBlock(result: WorkerTaskResult, perTaskCap: number): string {
  const head =
    `[${result.id}] ${result.status} — ${result.title} ` +
    `(${result.stepCount} steps, ${Math.round(result.durationMs / 1000)}s, ` +
    `${result.tools.calls} tool calls, ${result.tools.errors} errors)`;
  const body = result.reply.length > 0 ? result.reply : NO_REPLY;
  const clipped =
    body.length > perTaskCap
      ? `${body.slice(0, Math.max(0, perTaskCap - 15))}\n… [truncated]`
      : body;
  return result.error
    ? `${head}\n${clipped}\nerror: ${result.error}`
    : `${head}\n${clipped}`;
}
