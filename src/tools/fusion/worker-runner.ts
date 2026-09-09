import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import type { TurnOrigin } from "../../runtime/turn-controller.js";
import type { DelegateTask } from "./delegate-args.js";
import { renderWorkerBrief, WORKER_REPLY_CHAR_BUDGET } from "./worker-prompt.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";
import {
  FUSION_WORKER_APPROVAL_REFUSED,
  isWorkerVisibleTool,
} from "./worker-tool-policy.js";

export interface WorkerRunnerDeps {
  /** `runtime.runTurn`, unchanged. */
  runTurn: (
    session: SessionState,
    userMessage: string,
    options: {
      origin?: TurnOrigin;
      providerId?: string;
      maxSteps?: number;
      taskMaxDurationMs?: number;
      toolFilter?: (name: string) => boolean;
      signal?: AbortSignal;
      eventHook?: (event: AgentLoopEvent) => void;
    },
  ) => Promise<RunTurnResult>;
  /** `runtime.createEphemeralSession` — in-memory, never persisted. */
  createEphemeralSession: (meta: FusionWorkerMeta) => SessionState;
  approvals: Pick<ApprovalGate, "setSessionPolicy" | "clearSessionPolicy">;
  /** Progress into the PARENT session's frame. */
  emitEvent: (sessionId: string, event: AgentLoopEvent) => void;
  workingDir: string;
}

export interface RunWorkerTasksOptions {
  parentSessionId: string;
  tasks: readonly DelegateTask[];
  /** Concurrency ceiling, already reconciled against the slot pool. */
  maxWorkers: number;
  /** The local leg every worker turn is pinned to. */
  providerId: string;
  workerMaxSteps: number;
  workerTimeoutMs: number;
  signal: AbortSignal;
}

/**
 * Fan `tasks` out to concurrent local worker turns and collect what
 * comes back, in the caller's task order.
 *
 * The pool is an index-claiming loop rather than a library: `next` is
 * mutated synchronously by each of the N runners, so a runner that
 * finishes early immediately claims the next unstarted task and the
 * fan-out stays exactly `maxWorkers` wide without a queue object,
 * a semaphore, or a dependency.
 *
 * **Nothing here throws.** Every failure — a rejected turn, a timeout,
 * the operator aborting the orchestrator's turn — lands as a status on
 * a row. A fan-out that threw would take the orchestrator's whole turn
 * down and lose the parts that *did* succeed, which is the opposite of
 * what a delegation should cost.
 */
export async function runWorkerTasks(
  deps: WorkerRunnerDeps,
  options: RunWorkerTasksOptions,
): Promise<WorkerTaskResult[]> {
  const results: WorkerTaskResult[] = new Array(options.tasks.length);
  let next = 0;
  const claim = (): number => {
    const index = next;
    next += 1;
    return index;
  };
  const width = Math.max(1, Math.min(options.maxWorkers, options.tasks.length));
  const runners = Array.from({ length: width }, async () => {
    for (let i = claim(); i < options.tasks.length; i = claim()) {
      results[i] = await runOneTask(deps, options, options.tasks[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runOneTask(
  deps: WorkerRunnerDeps,
  options: RunWorkerTasksOptions,
  task: DelegateTask,
): Promise<WorkerTaskResult> {
  const startedAt = Date.now();
  const collector = new WorkerRunCollector();
  const session = deps.createEphemeralSession({
    parentSessionId: options.parentSessionId,
    taskId: task.id,
  });
  // A worker that queued on the parent id would wait behind the
  // orchestrator's own turn — which is the turn calling this — and the
  // fan-out would deadlock rather than run. `createEphemeralSession`
  // mints a fresh id, so this only fires if that contract ever breaks.
  if (session.id === options.parentSessionId) {
    return collector.finish({
      id: task.id,
      title: task.title,
      reason: null,
      stepCount: 0,
      durationMs: 0,
      error: "worker session id collided with the parent session id",
    });
  }

  // `started` fires when the turn actually begins stepping, not when it
  // is handed to the controller — and it therefore fires from inside the
  // worker's event hook, which runs under the WORKER's async context.
  // That is why the progress sink takes an explicit session id: an event
  // routed by the ambient frame would be tagged with a throwaway session
  // that has no recorder, no hook and no UI, and would reach nobody.
  let announced = false;
  const announceStart = (): void => {
    if (announced) return;
    announced = true;
    deps.emitEvent(options.parentSessionId, {
      type: "fusion_worker",
      taskId: task.id,
      title: task.title,
      phase: "started",
    });
  };
  // A worker has no operator: an approval prompt would park the turn
  // until process exit. Refuse instead, with the reason the brief told
  // the model to hand back up.
  deps.approvals.setSessionPolicy(session.id, {
    onPrompt: "refuse",
    reason: FUSION_WORKER_APPROVAL_REFUSED,
  });

  let result: WorkerTaskResult;
  try {
    const turn = await deps.runTurn(
      session,
      renderWorkerBrief(task, { workingDir: deps.workingDir }),
      {
        origin: "fusion",
        providerId: options.providerId,
        maxSteps: options.workerMaxSteps,
        taskMaxDurationMs: options.workerTimeoutMs,
        toolFilter: isWorkerVisibleTool,
        signal: AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.workerTimeoutMs),
        ]),
        eventHook: (event) => {
          if (event.type === "turn_started") announceStart();
          collector.observe(event);
        },
      },
    );
    result = collector.finish({
      id: task.id,
      title: task.title,
      reason: turn.reason,
      stepCount: turn.stepCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const aborted = options.signal.aborted || isAbortError(error);
    result = collector.finish({
      id: task.id,
      title: task.title,
      reason: aborted ? "cancelled" : null,
      stepCount: 0,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // Always: the gate is process-wide and a stale refusal policy keyed
    // to a dead session is a slow leak, not a visible bug.
    deps.approvals.clearSessionPolicy(session.id);
  }

  // Keep the feed paired: a turn that died before it ever stepped never
  // reached the hook, and a bare `failed` line about a worker the
  // operator never saw start reads like a phantom.
  announceStart();
  deps.emitEvent(options.parentSessionId, {
    type: "fusion_worker",
    taskId: task.id,
    title: task.title,
    phase: workerPhase(result),
    stepCount: result.stepCount,
    durationMs: result.durationMs,
    summary: summarise(result),
  });
  return result;
}

function workerPhase(
  result: WorkerTaskResult,
): "finished" | "failed" | "cancelled" {
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "failed") return "failed";
  return "finished";
}

/** One line for the operator's feed — never the whole reply. */
function summarise(result: WorkerTaskResult): string {
  if (result.status === "needs_orchestrator") return "needs the orchestrator";
  const text = (result.error ?? result.reply).replace(/\s+/g, " ").trim();
  if (text.length === 0) return result.status;
  const cap = Math.min(120, WORKER_REPLY_CHAR_BUDGET);
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
