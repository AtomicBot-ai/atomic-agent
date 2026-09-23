import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { ReasoningEffort } from "../../llm/provider/completion-types.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import type { TurnOrigin } from "../../runtime/turn-controller.js";
import type { DelegateTask } from "./delegate-args.js";
import type { DelegateContract } from "./contract.js";
import { resolveContractInputs } from "./contract-inputs.js";
import {
  applyDeclaredFileReport,
  applyNoChangesRule,
  inspectDeclaredFiles,
} from "./declared-files.js";
import type { DeclaredInputsRegistry } from "../os/fs-declared-inputs.js";
import {
  renderWorkerBrief,
  WORKER_REPLY_CHAR_BUDGET,
} from "./worker-prompt.js";
import {
  WorkerRunCollector,
  WORKER_HINT_QUEUED,
  WORKER_QUEUED_NOTE,
  type WorkerTaskResult,
} from "./worker-result.js";
import { getConfig } from "../../config/index.js";
import {
  FUSION_WORKER_APPROVAL_REFUSED,
  WORKER_TOOL_ROLE,
  isWorkerVisibleTool,
} from "./worker-tool-policy.js";
import type { ToolRole } from "../tool-roles.js";
import { fingerprintToolOutcome } from "../../agent/loop-detector.js";

/**
 * How many `phase: "tool"` lines one worker may put in the parent's
 * feed. Five is a deliberate compromise: enough to see what a worker
 * reached for after it started, few enough that the worst case (8
 * workers) is 40 lines — the same order as a single orchestrator turn's
 * own feed — instead of an unbounded log.
 */
export const WORKER_TOOL_LINES_PER_TASK = 5;

/**
 * A local worker's time limit, sized from what it has to produce and how
 * fast this machine produces it (D4 / F19). The estimate is the brief
 * (≈ chars / 4 tokens) plus 2,000 tokens per declared output file, at
 * the measured generation speed, times three for reads, reasoning and
 * retries; clamped to [10 min, ceiling], where the ceiling is the
 * configured `workerTimeoutMs` (45 min by default). Two local workers
 * once ran the full 45 minutes, one in a read loop; a 4B model writing
 * a module is done in far less, and a stuck one should end sooner.
 *
 * Without a measured speed (nothing has completed yet, or the leg is a
 * cloud one) the ceiling is the limit, as before.
 */
export const WORKER_TIMEOUT_FLOOR_MS = 600_000;
export const WORKER_TOKENS_PER_DECLARED_FILE = 2_000;
export const WORKER_TIMEOUT_SAFETY_FACTOR = 3;

export function estimateWorkerTimeoutMs(input: {
  briefChars: number;
  declaredFiles: number;
  tokensPerSecond: number | null | undefined;
  ceilingMs: number;
}): number {
  const { tokensPerSecond, ceilingMs } = input;
  if (
    tokensPerSecond === null ||
    tokensPerSecond === undefined ||
    !Number.isFinite(tokensPerSecond) ||
    tokensPerSecond <= 0
  ) {
    return ceilingMs;
  }
  const tokens =
    input.briefChars / 4 +
    WORKER_TOKENS_PER_DECLARED_FILE * Math.max(0, input.declaredFiles);
  const estimateMs =
    (tokens / tokensPerSecond) * WORKER_TIMEOUT_SAFETY_FACTOR * 1000;
  const floor = Math.min(WORKER_TIMEOUT_FLOOR_MS, ceilingMs);
  return Math.round(Math.max(floor, Math.min(ceilingMs, estimateMs)));
}

/**
 * How much of its own budget a worker may spend waiting for its first
 * token. A third: long enough that a busy two-slot server still serves
 * a queued worker rather than failing it, short enough that a worker
 * which never gets a slot reports back with two thirds of its deadline
 * unspent, so the orchestrator can re-plan inside the same turn.
 */
export const WORKER_QUEUE_BUDGET_DIVISOR = 3;

/**
 * Events that prove the server answered THIS worker, ending its queue
 * wait. Deliberately not `prompt_built`, `turn_started` or
 * `step_started`: all three fire before the request is answered, and a
 * queued worker reaches every one of them.
 */
const SERVED_EVENTS: ReadonlySet<string> = new Set([
  "assistant_delta",
  "reasoning_delta",
  "reasoning",
  "llm_completed",
  "llm_raw_completion",
  "tool_call_parsed",
  // A tool that RAN is a tool the model asked for: the tokens carrying
  // that call arrived, whatever the provider chose to stream.
  "tool_call_executed",
  "assistant_reply",
]);

/**
 * How far above the configured default a single task may be sized by
 * the orchestrator. Four: a task the planner judges big gets real room
 * (60 steps -> 240, 45 min -> 3 h) while a runaway still ends within a
 * working afternoon rather than never.
 *
 * The factor applies to the CONFIGURED default, not to whatever the
 * orchestrator asked for, so raising the default in config raises the
 * ceiling with it and the multiplier is never applied twice.
 */
export const WORKER_BUDGET_CEILING_FACTOR = 4;

/**
 * A per-task budget the orchestrator asked for, clamped into what the
 * install allows. Clamped rather than refused: the number is the
 * planner's estimate of the work, and a refusal would cost a whole
 * regeneration to correct one integer. `clamped` is what the result
 * tells the orchestrator, so a plan built on a bigger number is not
 * silently run on a smaller one.
 */
export function clampTaskBudget(
  requested: number | undefined,
  configured: number,
): { value: number; clamped: boolean } {
  if (requested === undefined) return { value: configured, clamped: false };
  const ceiling = configured * WORKER_BUDGET_CEILING_FACTOR;
  const value = Math.max(1, Math.min(Math.floor(requested), ceiling));
  return { value, clamped: value !== Math.floor(requested) };
}

/**
 * The wait for a first token, bounded by the worker's own budget.
 *
 * `localModels.firstTokenTimeoutMs` defaults to 30 minutes because a
 * queued request is a healthy request — but that number was set for a
 * turn with no deadline of its own. A worker has one, and giving it a
 * first-token budget it cannot outlive is what let a queued worker burn
 * 45 minutes producing nothing.
 */
export function resolveQueueBudgetMs(
  timeoutMs: number,
  firstTokenTimeoutMs?: number,
): number {
  const configured =
    firstTokenTimeoutMs ?? getConfig().localModels.firstTokenTimeoutMs;
  const share = Math.floor(timeoutMs / WORKER_QUEUE_BUDGET_DIVISOR);
  const bounded = Math.min(
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : share,
    share,
  );
  return Math.max(1, bounded);
}

/** Tools whose success counts as "the worker wrote something". */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
]);

/**
 * How many steps must have COMPLETED, none of them a successful write,
 * before a task with declared files can be handed back early (F42).
 *
 * One completed step without a write is a worker that read the spec.
 * Two is a worker that is still not writing after it has seen what it
 * read — the pattern the hand-back exists for (two workers once spent
 * 40 steps each that way). The rule is evaluated only when a step
 * finishes, so nothing is ever in flight when it fires: F19 checked it
 * on a timer at half the time limit, and on a 6 tok/s local worker
 * that fired 1,350 s into the worker's FIRST completion — 7,293 tokens
 * of the file it was about to write, discarded for a re-brief from
 * scratch, with zero completed steps to show for 22 minutes.
 */
export const HAND_BACK_MIN_COMPLETED_STEPS = 2;

/**
 * Tools whose success is not progress on a task that declared files
 * (F46): a read, a listing, a glob, a grep, a watch, a process list. A
 * step whose only successful results are these looked at the tree; a
 * step that ran a shell command, wrote or edited did something to it.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.read",
  "os.fs.read_document",
  "os.fs.list",
  "os.fs.glob",
  "os.fs.grep",
  "os.fs.watch",
  "os.fs.locate_project",
  "os.fs.archive.list",
  "os.fs.archive.read_entry",
  "os.proc.list",
  "os.window.list",
  "tool.view",
]);

/**
 * The step half of the hand-back fires only on a STALLED worker (F46):
 * either its last `HAND_BACK_SAME_RESULT_STEPS` completed steps came
 * back with the same outcome fingerprint (F25's `fingerprintToolOutcome`
 * — a worker re-checking for a file that does not exist yet, whatever
 * the arguments), or its last `HAND_BACK_READ_ONLY_STEPS` steps had no
 * successful non-read result at all. A worker making distinct,
 * successful shell calls each step — hashing one file per call — is
 * busy, and runs to its budget: three of those were handed back at
 * half their steps in one live fan-out, and the one that was working
 * never reached its write. The time half is unchanged.
 */
export const HAND_BACK_SAME_RESULT_STEPS = 3;
export const HAND_BACK_READ_ONLY_STEPS = 6;

/** What one completed worker step produced, for the stall check. */
export interface WorkerStepOutcome {
  /** The step's tool results' fingerprints, in order; empty for a step with none. */
  fingerprint: string;
  /** True when some result was a success from a tool outside `READ_ONLY_TOOLS`. */
  busy: boolean;
}

/**
 * Why the worker's recent steps look stalled, or `undefined` while it is
 * still doing something: `same result 3×`, `read-only for 6 steps`, or
 * both joined with ` / `.
 */
export function detectStall(
  steps: readonly WorkerStepOutcome[],
): string | undefined {
  const reasons: string[] = [];
  if (steps.length >= HAND_BACK_SAME_RESULT_STEPS) {
    const tail = steps.slice(-HAND_BACK_SAME_RESULT_STEPS);
    if (tail.every((s) => s.fingerprint === tail[0]!.fingerprint)) {
      reasons.push(`same result ${HAND_BACK_SAME_RESULT_STEPS}×`);
    }
  }
  if (steps.length >= HAND_BACK_READ_ONLY_STEPS) {
    const tail = steps.slice(-HAND_BACK_READ_ONLY_STEPS);
    if (tail.every((s) => !s.busy)) {
      reasons.push(`read-only for ${HAND_BACK_READ_ONLY_STEPS} steps`);
    }
  }
  return reasons.length === 0 ? undefined : reasons.join(" / ");
}

/** The forced summary a handed-back task replies with. */
export function formatEarlyHandBack(input: {
  stepsTaken: number;
  stepBudget: number;
  elapsedMs: number;
  timeoutMs: number;
  findings: string;
}): string {
  const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;
  return (
    `handed back early: no file written by half the budget ` +
    `(${input.stepsTaken} of ${input.stepBudget} steps, ${minutes(input.elapsedMs)} of ${minutes(input.timeoutMs)}); ` +
    `what I found: ${input.findings}`
  );
}

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
      toolRole?: ToolRole;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
      signal?: AbortSignal;
      eventHook?: (event: AgentLoopEvent) => void;
    },
  ) => Promise<RunTurnResult>;
  /** `runtime.createEphemeralSession` — in-memory, never persisted. */
  createEphemeralSession: (meta: FusionWorkerMeta) => SessionState;
  approvals: Pick<ApprovalGate, "setSessionPolicy" | "clearSessionPolicy"> &
    Partial<Pick<ApprovalGate, "fanoutScopes">>;
  /**
   * Where a worker's declared inputs (the contract's `inputs`, F51) are
   * registered for its session so `os.fs.write` refuses to replace
   * them. Absent (tests, embedders) declares nothing.
   */
  declaredInputs?: Pick<DeclaredInputsRegistry, "declare" | "clear">;
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
  /**
   * Display label for the model the workers run on, already resolved by
   * the caller (`runMode.workerModel ?? providerId`). Resolved there
   * rather than here because the runner has no config access and must
   * never invent a name it cannot stand behind.
   */
  workerModel: string;
  workerMaxSteps: number;
  /**
   * Wall-clock ceiling per worker turn. With `localTokensPerSecond` it
   * is the ceiling of a per-task estimate (`estimateWorkerTimeoutMs`);
   * without, it is the limit itself.
   */
  workerTimeoutMs: number;
  /**
   * The local leg's measured generation speed
   * (`LlamaServerClient.measuredTokensPerSecond`), `null` when nothing
   * has completed yet. Absent for a cloud leg, which keeps the ceiling.
   */
  localTokensPerSecond?: number | null;
  /** `runMode.fusion.workerReasoning`, sent with every worker completion. */
  workerReasoning?: ReasoningEffort;
  /** `runMode.fusion.workerMaxOutputTokens`, the per-step output cap. */
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
   * The operator's request behind the orchestrator's turn, quoted into
   * every worker's brief as context (`renderWorkerBrief`). Absent when
   * the parent turn has none to give.
   */
  originalRequest?: string;
  /**
   * The fan-out's contract, rendered into every brief above the task
   * (`renderWorkerBrief`). Checked after the fan-out by the caller.
   */
  contract?: DelegateContract;
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
      role: "worker",
      model: options.workerModel,
    });
  };

  // Which tool this worker just picked up, named with the model running
  // it — the operator's only view of how the fan-out is spending, since
  // a worker's own step events are tagged with a session the UI drops.
  //
  // Bounded, because eight workers times a dozen tools each is a feed
  // that shows nothing else. Two limits: a consecutive repeat is
  // swallowed (a worker grepping fifteen times is one fact, not
  // fifteen), and each worker announces at most
  // `WORKER_TOOL_LINES_PER_TASK` tools in total. Nothing is lost — the
  // complete per-tool tally comes back on the task's result row and
  // into the orchestrator's transcript; the feed only has to answer
  // "who is doing what right now".
  let toolLines = 0;
  let lastTool = "";
  const announceTool = (tool: string): void => {
    // The two terminals end the worker's turn, they are not work the
    // operator is waiting on; the `done` line already reports that.
    if (tool === "reply" || tool === "finish") return;
    if (tool === lastTool) return;
    lastTool = tool;
    if (toolLines >= WORKER_TOOL_LINES_PER_TASK) return;
    toolLines += 1;
    deps.emitEvent(options.parentSessionId, {
      type: "fusion_worker",
      taskId: task.id,
      title: task.title,
      phase: "tool",
      role: "worker",
      model: options.workerModel,
      tool,
    });
  };
  // A worker has no operator: an approval prompt would park the turn
  // until process exit. Refuse instead, with the reason the brief told
  // the model to hand back up.
  deps.approvals.setSessionPolicy(session.id, {
    onPrompt: "refuse",
    reason: FUSION_WORKER_APPROVAL_REFUSED,
  });
  // …and the half that lets it work at all. The operator answered one
  // question at the fan-out naming these directories; inside them this
  // worker writes unprompted. The refuse policy above still catches
  // everything else, so straying outside the scope comes back as
  // `needs_orchestrator` — a task to re-delegate, not a dead worker.
  const writeScope = options.writeScope ?? [];
  if (writeScope.length > 0) {
    deps.approvals.fanoutScopes?.grant(session.id, writeScope);
  }
  // The contract's inputs (F51), resolved as this worker's tools will
  // resolve them: `os.fs.write` on one is refused whatever the brief
  // says, with no `overwrite` exemption — the orchestrator redeclares.
  const inputs = resolveContractInputs(
    options.contract?.inputs ?? [],
    deps.workingDir,
  );
  if (inputs.length > 0) deps.declaredInputs?.declare(session.id, inputs);

  const brief = renderWorkerBrief(task, {
    workingDir: deps.workingDir,
    ...(options.originalRequest === undefined
      ? {}
      : { originalRequest: options.originalRequest }),
    ...(options.contract === undefined ? {} : { contract: options.contract }),
  });
  const declaredFiles = task.files?.length ?? 0;
  // Per-task budgets the orchestrator sized itself, clamped into what
  // this install allows. A task that asked for nothing keeps the
  // configured defaults, byte for byte as before.
  const stepBudget = clampTaskBudget(task.maxSteps, options.workerMaxSteps);
  const timeBudget = clampTaskBudget(task.timeoutMs, options.workerTimeoutMs);
  const budgetNotes: string[] = [];
  if (stepBudget.clamped) {
    budgetNotes.push(
      `maxSteps ${task.maxSteps} was clamped to ${stepBudget.value} (${WORKER_BUDGET_CEILING_FACTOR}x the configured ${options.workerMaxSteps})`,
    );
  }
  if (timeBudget.clamped) {
    budgetNotes.push(
      `timeoutMs ${task.timeoutMs} was clamped to ${timeBudget.value} (${WORKER_BUDGET_CEILING_FACTOR}x the configured ${options.workerTimeoutMs})`,
    );
  }
  // Sized from the work and the machine when the leg is local and has
  // been measured; the task's own ceiling otherwise. A task that named
  // a `timeoutMs` is stating what the work needs, so it is the ceiling
  // the estimate is taken against.
  const timeoutMs = estimateWorkerTimeoutMs({
    briefChars: brief.length,
    declaredFiles,
    tokensPerSecond: options.localTokensPerSecond,
    ceilingMs: timeBudget.value,
  });

  // The worker's own clock, kept apart from the operator's signal: when
  // it is the one that fired, the worker ran out of time — a ceiling,
  // reported as `timeout` — rather than being cancelled by anybody.
  // This is the hard bound: it fires mid-generation by design, because
  // a worker stuck in one endless step has nothing else to end it. A
  // plain timer rather than `AbortSignal.timeout` so a test clock can
  // drive it; the reason is the `TimeoutError` Node would have raised.
  //
  // **It does not start until the server answers.** Arming it here used
  // to mean the clock ran while the request sat in llama-server's queue
  // behind busy slots, and that wait is long by design: the first-token
  // budget is 30 minutes (`localModels.firstTokenTimeoutMs`) precisely
  // because queueing is legitimate, and `first-token-stall` cannot end
  // it while the other slots are genuinely working. A 45-minute worker
  // could therefore burn two thirds of its budget without being served
  // and die reporting zero steps. Measured in the field: a 4-task
  // fan-out on a 2-slot server lost its last two workers that way, each
  // after 45 minutes with no tool call at all.
  //
  // So there are two clocks. The queue watchdog bounds the wait for the
  // FIRST token; the wall timer bounds the work, and only starts once
  // that token has arrived.
  const timeLimitController = new AbortController();
  const timeLimit = timeLimitController.signal;
  const abortForTime = (): void => {
    timeLimitController.abort(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
  };
  const queueBudgetMs = resolveQueueBudgetMs(timeoutMs);
  let queuedOut = false;
  let servedAt: number | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const queueTimer = setTimeout(() => {
    queuedOut = true;
    abortForTime();
  }, queueBudgetMs);
  queueTimer.unref?.();
  /**
   * The server produced something for this worker: the queue is over and
   * the worker's real budget starts now. Idempotent — every token after
   * the first lands here too.
   */
  const markServed = (): void => {
    if (servedAt !== null) return;
    servedAt = Date.now();
    clearTimeout(queueTimer);
    wallTimer = setTimeout(abortForTime, timeoutMs);
    wallTimer.unref?.();
  };
  const hitTimeLimit = (): boolean =>
    timeLimit.aborted && !options.signal.aborted && !queuedOut;
  const hitQueueLimit = (): boolean =>
    queuedOut && !options.signal.aborted;

  // D4 / F42 / F46: a task that declared output files and has written
  // none by half its step budget (and is stalled — `detectStall`) or by
  // half its time is handed back with what it found, instead of
  // spending the other half the same way — but only at a step boundary,
  // and only once `HAND_BACK_MIN_COMPLETED_STEPS` steps have completed.
  // The check runs when a step finishes, never on
  // a timer: at that moment the step's completion and its tool calls
  // are done and the next completion has not been requested, so the
  // abort costs nothing that was generated. Only for tasks with declared
  // files: a task that legitimately reads before it reports has no
  // half-way mark to miss.
  const handBack = new AbortController();
  const stepThreshold = Math.max(
    HAND_BACK_MIN_COMPLETED_STEPS,
    Math.floor(stepBudget.value / 2),
  );
  const halfTimeMs = Math.floor(timeoutMs / 2);
  let stepsFinished = 0;
  let wroteSomething = false;
  // What each completed step produced (F46): the current step's results
  // accumulate here and are folded into `steps` when it finishes.
  const steps: WorkerStepOutcome[] = [];
  let currentFingerprints: string[] = [];
  let currentBusy = false;
  // Why the step half fired, when it did; carried onto the note so the
  // orchestrator re-briefs against the cause, not just the count.
  let stall: string | undefined;
  const maybeHandBack = (): void => {
    if (declaredFiles === 0 || wroteSomething || handBack.signal.aborted) return;
    if (stepsFinished < HAND_BACK_MIN_COMPLETED_STEPS) return;
    const pastHalfTime = Date.now() - startedAt >= halfTimeMs;
    // The step half needs a stalled worker, not merely a busy one at
    // half its budget; the time half fires as before.
    const stalled = detectStall(steps);
    const pastHalfSteps = stepsFinished >= stepThreshold && stalled !== undefined;
    if (!pastHalfSteps && !pastHalfTime) return;
    stall = stalled;
    handBack.abort(new Error("handed back early: no file written by half the budget"));
  };
  const handedBack = (): boolean =>
    handBack.signal.aborted && !options.signal.aborted && !timeLimit.aborted;
  // Whether the hand-back is what ended the turn. The rule can also
  // trip on the step that closed the turn by itself (a `reply` at the
  // threshold); that worker finished, and its reply stands — the
  // ground-truth check below classifies it, not the hand-back.
  let stoppedByHandBack = false;
  let queuedOutcome = false;
  let timedOutOutcome = false;

  let result: WorkerTaskResult;
  try {
    const turn = await deps.runTurn(session, brief, {
      origin: "fusion",
      providerId: options.providerId,
      maxSteps: stepBudget.value,
      taskMaxDurationMs: timeoutMs + queueBudgetMs,
      toolFilter: isWorkerVisibleTool,
      toolRole: WORKER_TOOL_ROLE,
      ...(options.workerReasoning === undefined
        ? {}
        : { reasoningEffort: options.workerReasoning }),
      ...(options.workerMaxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.workerMaxOutputTokens }),
      signal: AbortSignal.any([options.signal, timeLimit, handBack.signal]),
      eventHook: (event) => {
        // The first token — not `turn_started`, which fires before the
        // request is even sent — is what ends the queue wait.
        if (event.type === "llm_event" && SERVED_EVENTS.has(event.event.type)) {
          markServed();
        }
        // Backstop for a provider that emits none of the above: by the
        // time a step has finished, tokens demonstrably arrived.
        if (event.type === "step_finished") markServed();
        if (event.type === "turn_started") announceStart();
        if (event.type === "step_finished") {
          // `step_finished`, not `step_started`: a started step is a
          // request in flight, and F19's count of those is how a
          // worker was stopped mid-file.
          steps.push({
            fingerprint: currentFingerprints.join("\n"),
            busy: currentBusy,
          });
          currentFingerprints = [];
          currentBusy = false;
          stepsFinished += 1;
          maybeHandBack();
        }
        if (
          event.type === "llm_event" &&
          event.event.type === "tool_call_parsed"
        ) {
          // `tool_call_parsed` fires before execution, which is what
          // "is being triggered" means — and it fires once per call in
          // a batched step, so the dedupe above earns its keep.
          announceStart();
          announceTool(event.event.call.tool);
        }
        if (
          event.type === "llm_event" &&
          event.event.type === "tool_call_executed"
        ) {
          const result = event.event.result;
          if (result.status === "ok" && WRITE_TOOLS.has(result.tool)) {
            wroteSomething = true;
          }
          currentFingerprints.push(fingerprintToolOutcome(result.tool, result));
          if (result.status === "ok" && !READ_ONLY_TOOLS.has(result.tool)) {
            currentBusy = true;
          }
        }
        collector.observe(event);
      },
    });
    const timedOut = turn.reason === "cancelled" && hitTimeLimit();
    timedOutOutcome = timedOut;
    queuedOutcome = turn.reason === "cancelled" && hitQueueLimit();
    stoppedByHandBack = turn.reason === "cancelled" && handedBack();
    const stopCause = timedOut ? "time_ceiling" : turn.stopCause;
    result = collector.finish({
      id: task.id,
      title: task.title,
      reason: timedOut ? "max_steps" : turn.reason,
      stepCount: turn.stepCount,
      durationMs: Date.now() - startedAt,
      ...(stopCause === undefined ? {} : { stopCause }),
      // The loop stores the error that ended a failed turn on the
      // session; without it the orchestrator saw only "(the worker
      // produced no reply)" for a worker killed by its server.
      ...(turn.reason === "failed" && turn.session.lastError
        ? { error: turn.session.lastError }
        : {}),
    });
  } catch (error) {
    const timedOut = hitTimeLimit();
    timedOutOutcome = timedOut;
    queuedOutcome = hitQueueLimit();
    stoppedByHandBack = !timedOut && !queuedOutcome && handedBack();
    const aborted =
      !timedOut &&
      !queuedOutcome &&
      (options.signal.aborted || stoppedByHandBack || isAbortError(error));
    result = collector.finish({
      id: task.id,
      title: task.title,
      reason: timedOut ? "max_steps" : aborted ? "cancelled" : null,
      // A thrown turn reported no count; the steps the hook saw finish
      // are the ones that happened.
      stepCount: stoppedByHandBack ? stepsFinished : 0,
      durationMs: Date.now() - startedAt,
      ...(timedOut
        ? // The abort's own message ("aborted due to timeout") says
          // nothing the status does not; the collector's provider
          // error, when there is one, is the cause worth showing.
          { stopCause: "time_ceiling" as const }
        : { error: error instanceof Error ? error.message : String(error) }),
    });
  } finally {
    clearTimeout(queueTimer);
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    // Always: the gate is process-wide and a stale refusal policy keyed
    // to a dead session is a slow leak, not a visible bug.
    deps.approvals.clearSessionPolicy(session.id);
    deps.approvals.fanoutScopes?.clear(session.id);
    deps.declaredInputs?.clear(session.id);
  }

  // Out of time, not out of steps. Only this function knows whose clock
  // fired — `classifyWorkerStatus` sees a `cancelled` turn with a
  // `time_ceiling` cause and deliberately keeps `cancelled` ahead of it,
  // because an operator who cancelled a worker cancelled it. Here the
  // worker's OWN timer is what ended the turn, and the orchestrator's
  // remedy for that is a longer deadline, not a bigger step budget.
  if (timedOutOutcome) {
    result = { ...result, status: "timeout" };
  }

  // A budget the orchestrator asked for and did not get is something it
  // has to know: it planned the task against the bigger number.
  if (budgetNotes.length > 0) {
    result = { ...result, notes: [...(result.notes ?? []), ...budgetNotes] };
  }

  // A worker that never got a slot is not a worker that failed, ran out
  // of steps or was cancelled: it produced nothing because the machine
  // had nothing to give it. Saying so is the whole row — and it is the
  // fan-out's WIDTH that has to change, not the task or its budget, so
  // the status carries that hint rather than a bigger-deadline one.
  if (queuedOutcome) {
    const { error: _dropped, ...rest } = result;
    result = {
      ...rest,
      status: "queued",
      reply: WORKER_QUEUED_NOTE,
      stepCount: 0,
      hint: WORKER_HINT_QUEUED,
      notes: [
        ...(result.notes ?? []),
        `never served: no first token within ${Math.round(queueBudgetMs / 60_000)} min of being sent, while its own budget was ${Math.round(timeoutMs / 60_000)} min — the local server's slots were all busy`,
      ],
    };
  }

  // A hand-back is neither a cancellation nor a failure: the worker was
  // stopped by its own half-way rule and reports what it found, as a
  // task the orchestrator must re-brief.
  if (stoppedByHandBack) {
    const { error: _dropped, ...rest } = result;
    // The loop's own count when it reported one; the hook's count of
    // finished steps otherwise. Both count completed steps — the rule
    // only fires at a step boundary, so nothing was cut short.
    const completed = result.stepCount > 0 ? result.stepCount : stepsFinished;
    const summary = formatEarlyHandBack({
      stepsTaken: completed,
      stepBudget: stepBudget.value,
      elapsedMs: result.durationMs,
      timeoutMs,
      findings: collector.findings(),
    });
    result = {
      ...rest,
      status: "needs_orchestrator",
      reply: summary,
      stepCount: completed,
      notes: [
        ...(result.notes ?? []),
        `handed back early: declared files but wrote none by half the budget (${completed} steps completed, none a successful write)${stall === undefined ? "" : ` (stalled: ${stall})`} — re-brief with a narrower task or the exact content to write`,
      ],
    };
  }

  // Ground truth before the orchestrator reads the reply: a worker that
  // says it wrote a file it never wrote must not come back `ok`, and one
  // that wrote nothing at all is `no_changes`. Only for statuses that
  // still claim some work; a failed or cancelled task is expected to
  // have left its files missing.
  if (
    task.files !== undefined &&
    task.files.length > 0 &&
    (result.status === "ok" ||
      result.status === "max_steps" ||
      result.status === "needs_orchestrator")
  ) {
    const report = await inspectDeclaredFiles(
      task.files,
      deps.workingDir,
      startedAt,
    );
    result = applyNoChangesRule(applyDeclaredFileReport(result, report), report);
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
    role: "worker",
    model: options.workerModel,
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
  const clipped = text.length > cap ? `${text.slice(0, cap)}…` : text;
  // "I'm done!" over an untouched tree must not read as done in the feed.
  return result.status === "no_changes" ? `no changes — ${clipped}` : clipped;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
