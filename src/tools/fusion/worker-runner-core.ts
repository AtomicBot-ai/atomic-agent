/**
 * The shared half of the worker runner (ATO-1669): what any delegated
 * worker turn needs, Fusion or not. A separate ephemeral session and the
 * guard against colliding with the parent, progress into the parent's
 * frame, the approval policy, step and time limits, the turn itself, the
 * result row and stall detection.
 *
 * Fusion's add-ons (escalation, slot and queue watchdogs, local server
 * health, contract and declared inputs, spend, task tree, worktree
 * isolation, the judge, generation speed limits) are the
 * `Fusion...Extras` types below. Every one of them is optional and
 * documented as "absent: nothing happens", so a runner given only the
 * core fields is the same runner with those fields empty.
 *
 * Types only: the runner itself stays in `worker-runner.ts`, which keeps
 * its exported names (`WorkerRunnerDeps`, `RunWorkerTasksOptions`) as
 * core plus extras.
 */
import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-contract.js";
import type {
  CompletionUsage,
  ReasoningEffort,
} from "../../llm/provider/completion-types.js";
import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import type { TurnOrigin } from "../../runtime/turn-controller.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import type { DeclaredInputsRegistry } from "../os/fs/fs-declared-inputs.js";
import type { StructuredLogger } from "../../tracing/index.js";
import type { ToolRole } from "../tool-roles.js";
import type { DelegateTask } from "./delegate-args.js";
import type { DelegateContract } from "./contract.js";
import type { EscalationComplete, FusionLiveWorkers } from "./escalation.js";
import type { LocalHealthAnswer, LocalLegHealth } from "./local-leg-health.js";
import type {
  SlotOccupancy,
  WorkerPricing,
  WorkerTaskResult,
} from "./worker-result.js";

/** The origin a worker turn runs under when the options name none. */
export const DEFAULT_WORKER_TURN_ORIGIN: TurnOrigin = "fusion";

/** What every worker runner needs from the runtime. */
export interface WorkerRunnerCoreDeps {
  /** `runtime.runTurn`, unchanged. */
  runTurn: (
    session: SessionState,
    userMessage: string,
    options: {
      origin?: TurnOrigin;
      providerId?: string;
      /** The worker leg's model for this turn (`RunWorkerTasksOptions.turnModel`). */
      model?: string;
      maxSteps?: number;
      taskMaxDurationMs?: number;
      toolFilter?: (name: string) => boolean;
      toolRole?: ToolRole;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
      signal?: AbortSignal;
      eventHook?: (event: AgentLoopEvent) => void;
    },
  ) => Promise<RunTurnResult>;
  /** `runtime.createEphemeralSession` — in-memory, never persisted. */
  createEphemeralSession: (meta: FusionWorkerMeta, workingDir?: string, inheritWorkspace?: boolean) => SessionState;
  inheritWorkspace?: boolean;
  approvals: Pick<ApprovalGate, "setSessionPolicy" | "clearSessionPolicy"> &
    Partial<
      Pick<
        ApprovalGate,
        | "fanoutScopes"
        | "followDeclined"
        | "clearSessionGrants"
        | "hasDeclinedUnder"
        | "forgetDeclinedUnder"
        | "wouldPrompt"
        | "getLevel"
      >
    >;
  /** Progress into the PARENT session's frame. */
  emitEvent: (sessionId: string, event: AgentLoopEvent) => void;
  workingDir: string;
  /**
   * A generic log sink. Only Fusion's local-leg paths write to it today (a
   * raised task budget, a local dispatch, fresh connections); absent, a
   * raised budget is only noted on the row.
   */
  logger?: Pick<StructuredLogger, "info">;
}

/** Fusion's dependencies on top of the core. Each one absent does nothing. */
export interface FusionWorkerRunnerDepsExtras {
  /**
   * Where a worker's declared inputs (the contract's `inputs`, F51) are
   * registered for its session so `os.fs.write` refuses to replace
   * them. Absent (tests, embedders) declares nothing.
   */
  declaredInputs?: Pick<DeclaredInputsRegistry, "declare" | "clear">;
  /**
   * The local server's slot table at this moment (`GET /slots`, read by
   * `readSlotOccupancy`), `null` when it gave no readable answer. Asked
   * once, by a local worker's queue watchdog just before it ends the
   * worker, so the hint on the row says what the server was doing rather
   * than guessing from the worker count. Absent (tests, embedders, a
   * cloud leg) nothing is probed and the hint says only what is known.
   */
  probeSlotOccupancy?: () => Promise<SlotOccupancy | null>;
  /**
   * The local leg's dispatch health across fan-outs (ATO-917): marked
   * when a local worker is cut off, checked before the next local worker
   * is sent. Absent (tests, embedders, a cloud leg) nothing is checked.
   */
  localLegHealth?: LocalLegHealth;
  /** `LlamaServerClient.probeHealth`, the question the check above asks. */
  probeLocalHealth?: () => Promise<LocalHealthAnswer>;
  /**
   * The probe for one local leg's own server (ATO-1318), or `undefined`
   * when nothing can ask that server; then the check is skipped for it.
   * When set it replaces `probeLocalHealth`, which only ever asks the
   * main local server.
   */
  probeLocalHealthFor?: (
    providerId: string,
  ) => (() => Promise<LocalHealthAnswer>) | undefined;
  /**
   * One completion on the escalation provider (ATO-942). Absent, nothing
   * is ever escalated, manual or automatic.
   */
  escalationComplete?: EscalationComplete;
  /** `runtime.steer`: how an advisor's hint reaches a running worker. */
  steerWorker?: (sessionId: string, text: string) => boolean;
  /** Where running workers are registered for the person's stop / escalate. */
  liveWorkers?: FusionLiveWorkers;
  /**
   * Replace the process's HTTP connection pool before a local worker is
   * sent after one was cut off and the server still answered
   * (`renewTransportPool`, ATO-1357). Returns whether it did. Absent
   * (tests, embedders), nothing is renewed.
   */
  renewLocalTransport?: () => boolean;
}

/** What every worker run is asked to do. */
export interface WorkerRunnerCoreOptions {
  parentSessionId: string;
  tasks: readonly DelegateTask[];
  /** Concurrency ceiling, already reconciled against the slot pool. */
  maxWorkers: number;
  /** The local leg every worker turn is pinned to. */
  providerId: string;
  /**
   * Display label for the model the workers run on, already resolved by
   * the caller (`runMode.workerModel ?? providerId`). Resolved there
   * rather than here because the runner has no config access and must
   * never invent a name it cannot stand behind.
   */
  workerModel: string;
  /**
   * The model every worker turn asks `providerId` for (ATO-1560), when it
   * is not the entry's own chat model: `ResolvedRunMode.workerTurnModel`,
   * or a role's `turnModel`. Absent, the provider's configured model
   * answers, as before. Never set for a `llama-server` leg.
   */
  turnModel?: string;
  workerMaxSteps: number;
  /**
   * Wall-clock ceiling per worker turn. With `localTokensPerSecond` it
   * is the ceiling of a per-task estimate (`estimateWorkerTimeoutMs`);
   * without, it is the limit itself.
   */
  workerTimeoutMs: number;
  /** `runMode.fusion.workerReasoning`, sent with every worker completion. */
  workerReasoning?: ReasoningEffort;
  /**
   * `runMode.fusion.workerMaxOutputTokens`, the per-step output cap. A
   * measured local leg may send less: what fits the worker's time
   * (`fitReplyCapToTime`).
   */
  workerMaxOutputTokens?: number;
  /**
   * Directories these workers may write in without asking, as approved
   * by the operator on this fan-out's own prompt. Empty means nothing
   * was authorised — the workers then hit the refuse policy on every
   * write, exactly as they did before the fan-out prompt existed, and
   * the operator sees it as every task returning `needs_orchestrator`.
   */
  writeScope?: readonly string[];
  /**
   * False when nobody approved `writeScope` for these workers: the
   * standing level let the fan-out through (auto mode, ATO-1689), so the
   * workers get no fan-out scope and every step they take is decided by
   * the gate under that level, as the chat's own would be. Absent or true:
   * the scope is granted as before.
   */
  scopeApproved?: boolean;
  /**
   * The operator's request behind the orchestrator's turn, quoted into
   * every worker's brief as context (`renderWorkerBrief`). Absent when
   * the parent turn has none to give.
   */
  originalRequest?: string;
  signal: AbortSignal;
  /**
   * The origin every worker turn runs under (ATO-1669). Absent: `"fusion"`
   * (`DEFAULT_WORKER_TURN_ORIGIN`), as before. A subagent run passes
   * `"subagent"`, which the runtime treats like `"fusion"`.
   */
  origin?: TurnOrigin;
  /**
   * The depth stamped on every worker session (ATO-1670): the caller's
   * `childFusionWorkerDepth`. Absent: `FUSION_WORKER_DEFAULT_DEPTH` (1),
   * as Fusion always stamps, since it fans out only from the operator.
   */
  depth?: number;
  /**
   * What a worker's approval prompt is refused with, for a caller whose
   * workers do not answer to a Fusion orchestrator (ATO-1670).
   * `general` must keep `FUSION_WORKER_APPROVAL_MARKER` so the row still
   * comes back `needs_orchestrator`; `reasonFor` picks a refusal per
   * request, like `workerRefusalFor`. Absent: Fusion's own texts.
   */
  approvalRefusal?: {
    general: string;
    reasonFor?: (request: ApprovalRequest) => string | undefined;
  };
  /**
   * Asked before each task starts: a reason means the task is not
   * started and comes back `cancelled` with that reason (the turn's cap,
   * ATO-947). Absent, every task starts as before. In the core since
   * ATO-1670: `subagent.run` stops on the agent turn's spend ceiling.
   */
  shouldStart?: () => string | undefined;
  /** Every worker completion's usage, as it lands (live spend, ATO-947). */
  onWorkerUsage?: (taskId: string, usage: CompletionUsage) => void;
  /** Each task's row as soon as it is final, before the fan-out returns (ATO-617). */
  onTaskFinished?: (result: WorkerTaskResult) => void;
}

/** Fusion's options on top of the core. Each one absent does nothing. */
export interface FusionWorkerRunnerOptionsExtras {
  /**
   * The local leg's measured generation speed
   * (`LlamaServerClient.measuredTokensPerSecond`), `null` when nothing
   * has completed yet. Absent for a cloud leg, which keeps the ceiling.
   */
  localTokensPerSecond?: number | null;
  /**
   * The workers run on a local (slot-affine) leg. Turns on the local
   * floors (`LOCAL_WORKER_TASK_BUDGET_FLOOR_MS`,
   * `LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS`) and the slot probe. Explicit
   * because `localTokensPerSecond` is `null` both on a cloud leg and on
   * a local one nothing has been measured on yet.
   */
  localLeg?: boolean;
  /**
   * The fan-out's contract, rendered into every brief above the task
   * (`renderWorkerBrief`). Checked after the fan-out by the caller.
   */
  contract?: DelegateContract;
  /**
   * Asked only before a task starts, after `shouldStart`: the failure
   * breaker (ATO-1406). Unlike `shouldStart` it never refuses an
   * escalation or cuts a run already going, so running workers finish.
   */
  shouldStartTask?: () => string | undefined;
  /**
   * Where a stuck worker may be escalated, and that model's price when
   * known (ATO-942). Absent: no escalation of any kind.
   */
  escalation?: { target: FusionEscalationTarget; pricing?: WorkerPricing };
  /** What an escalation cost, as it lands, for the turn's cap. */
  onEscalationSpend?: (taskId: string, usd: number) => void;
  /** The worker model's price, for the live $ on its row. Absent: tokens only. */
  workerPricing?: WorkerPricing;
  /**
   * Text appended to a task's brief: its acceptance checklist and, on a
   * judge's retry, what was found not met (ATO-944). Absent: the brief
   * is exactly as before.
   */
  briefSuffix?: (taskId: string) => string | undefined;
  /**
   * The workspace a task runs in instead of the working directory, and
   * the write scope rebased onto it (branch isolation, ATO-946). Absent,
   * or `undefined` for a task: the working directory, as before.
   */
  taskWorkspace?: (
    taskId: string,
  ) => { workingDir: string; writeScope: readonly string[] } | undefined;
  /**
   * The task tree (ATO-940): whether this task may still propose a
   * split. True, the half-budget hand-back and a cut first answer first
   * steer the worker toward a `split_proposal` (once, with
   * `SPLIT_GRACE_STEPS` more steps), and a reply that carries one skips
   * the declared-file check: the files are its children's to write.
   * Absent: exactly as before.
   */
  canProposeSplit?: (taskId: string) => boolean;
  /**
   * Every tool a worker starts, unthrottled (the feed's lines are capped
   * per task). The run checkpoint (ATO-617) records side effects from it.
   */
  onWorkerTool?: (taskId: string, tool: string) => void;
}
