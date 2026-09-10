import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import type { SlotManager } from "../llm/slot-manager.js";
import type { ToolCallTransport } from "../llm/provider/completion-types.js";
import type { ToolCallAdapter } from "../llm/provider/adapters/tool-call-adapter.js";
import {
  PLAIN_INSTRUCT_PROFILE,
  type ModelProfile,
} from "../llm/model-profile.js";
import type { ModelProfileManager } from "../llm/model-profile-manager.js";
import type { LocalBackendGate } from "../llm/local-backend-gate.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  CancelledError,
  LlmFailure,
  TransportError,
  classifyFailure,
  isRequestSizeRejection,
} from "../llm/index.js";
import type {
  LlmFailureCategory,
  TruncationCause,
  TruncationDetail,
} from "../llm/index.js";
import type { SessionState } from "../session/session-state.js";
import { incrementTurnCount, recordTurn } from "../session/session-state.js";
import { assistantReplyTurn, userTurn } from "../session/conversation-turn.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import type { MemoryEntry, MemoryIndexEntry } from "../memory/memory-store.js";
import type { LessonIndexEntry } from "../memory/lessons/lesson-store.js";
import type { ProcedureIndexEntry } from "../memory/procedures/procedure-store.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { ReflectionRunner } from "../memory/reflection/index.js";
import { executeStep } from "./step-executor.js";
import type { LlmStreamParams, StepEvent } from "./step-executor.js";
import {
  ToolLoopTracker,
  READ_REPEAT_WARNING_THRESHOLD,
  TEST_REPEAT_WARNING_THRESHOLD,
  formatReadRepeatNotice,
  formatRepeatNotice,
  formatTestRepeatNotice,
  formatWanderingRedirect,
  formatForcedLoopReply,
} from "./loop-detector.js";
import type { BatchLoopSignal } from "./batch-executor.js";
import { composeSteerNotice } from "./steer-notice.js";
import {
  composeTruncationNotice,
  planTruncationRetry,
  type TruncationRetry,
  type TruncationRetryPlan,
} from "./truncation-recovery.js";
import {
  PARSE_RECOVERY_BUDGET,
  composeParseFailureNotice,
  formatTurnFailedRecord,
  isRecoverableParseFailure,
} from "./parse-failure-recovery.js";
import {
  EMPTY_COMPLETION_RECOVERY_BUDGET,
  composeEmptyCompletionNotice,
  isRecoverableEmptyCompletion,
  repeatedEmptyCompletionError,
} from "./empty-completion-recovery.js";
import { getConfig } from "../config/index.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

export interface AgentLoopDependencies {
  registry: ToolRegistry;
  /**
   * Plan mode, read per call. A getter rather than a boolean so a mode
   * the operator flips mid-session is observed by the next tool call
   * rather than by the next process — the same reasoning the approval
   * gate uses for `approvalRequired`.
   */
  isPlanMode?: () => boolean;
  /**
   * Whether the run mode resolves to fusion right now. Read per turn,
   * for the reason `isPlanMode` is read per call: the operator can flip
   * the mode between turns and the next turn should honour it. Absent
   * (embedders, tests) means "not fusion", which gates nothing.
   */
  isFusionMode?: () => boolean;
  slotManager: SlotManager;
  grammar: string;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  /**
   * Optional streaming sibling of `llmComplete`. When wired, live
   * `reasoning_delta` and `assistant_delta` step events flow to
   * `onEvent` while the model is still generating.
   */
  llmCompleteStream?: (
    params: LlmStreamParams,
  ) => AsyncGenerator<StreamChunk, CompletionResult, void>;
  /** Stable tool catalog used in the prompt prefix. Pass the same array on every step. */
  toolDescriptors: readonly ToolDescriptor[];
  /** Stable capabilities summary, computed once at session start. */
  capabilities: CapabilitiesSummary;
  /** Model-specific reasoning behaviour derived from llama-server /props. */
  profile?: ModelProfile;
  /**
   * Context window resolved from the model catalogue, for providers with
   * no `/props` probe. Read per step so a mid-session model swap is
   * reflected without restarting the loop.
   */
  contextWindow?: () => number | null;
  /**
   * The model server just revealed its real context window: a reply
   * stopped `context_window`-truncated after this many prompt + reply
   * tokens. Bootstrap records it per provider/model so the next prompt
   * is packed to fit (`contextWindow` above then returns it). Absent in
   * test / legacy wiring, where a window truncation ends the turn.
   */
  onContextWindowObserved?: (contextWindow: number) => void;
  /**
   * A completion just succeeded with prompt + reply tokens above the
   * window the runtime believes in. Whatever taught it that window was
   * wrong (a provider clamping output, a stale observation); bootstrap
   * forgets the learned value so the prompt is not packed to a number
   * the server just disproved.
   */
  onContextWindowExceeded?: (tokens: number) => void;
  /** Defaults to `grammar` when omitted (test / legacy wiring). */
  toolTransport?: ToolCallTransport;
  toolCallAdapter?: ToolCallAdapter | null;
  supportsSlotAffinity?: boolean;
  /**
   * Whether the active native-tools provider can emit parallel tool
   * calls. Defaults to `true` when omitted (legacy / grammar-only
   * wiring). Combined with `agent.maxParallelToolCalls` to decide the
   * `parallel_tool_calls` wire flag (issue #104).
   */
  supportsParallelTools?: boolean;
  /**
   * Resolve the wire slice for a provider a turn is pinned to
   * (`RunTurnOptions.providerId`). The four global fields above describe
   * the ACTIVE provider; a fusion worker turn runs on a different one
   * (the local leg) inside the same process, so its steps must be built
   * for that link's transport, adapter and slot affinity, not the
   * orchestrator's. Resolved once per pinned turn. Absent, a pinned turn
   * falls back to the global fields (test / legacy wiring).
   */
  resolveLlmSlice?: (providerId: string) => ResolvedTurnLlmSlice;
  /**
   * Optional hot-swap supervisor. When provided, the loop re-probes
   * `/props` at the start of every turn and inspects the `modelId` of
   * each completion; if the operator swaps the model behind
   * `llama-server`, the profile and grammar are refreshed before the
   * next step so the prompt no longer drifts out of template. When
   * absent, the static `profile`/`grammar` deps above are used verbatim
   * for the lifetime of the loop (test-mode wiring).
   */
  profileManager?: ModelProfileManager;
  /**
   * Gate for the `profileManager` probes above (issue #112). The manager
   * talks to the local llama-server, so on a cloud turn its refreshes
   * are pure `/props` noise against a backend nothing is routed to —
   * `isActive()` false skips them. `ensureProbed()` covers the reverse
   * case: the operator switched back to a local provider after a cloud
   * boot that deferred the probes, and this turn is the first local one.
   * It returns `true` when it just ran them, which already includes a
   * fresh `/props` — the loop then skips its own refresh rather than
   * probing twice. Absent (test / legacy wiring) means "always local",
   * preserving the pre-#112 behaviour.
   */
  localBackend?: LocalBackendGate;
  /** Skill catalog (name + description only), rebuilt on install/uninstall. */
  skillCatalog: readonly SkillCatalogEntry[];
  /**
   * Invoked once per step to produce the current user-profile snapshot.
   * The resulting array is rendered into the `### profile` section of
   * the prompt tail. `undefined` suppresses the section entirely — wire
   * this only when the memory fabric is enabled.
   */
  profileFactsProvider?: () => readonly ProfileFact[];
  /**
   * Optional pre-step memory hook. Invoked before the first step and
   * refreshed after non-terminal tool results to populate the ephemeral
   * `recalledNotes` / `memoryIndex` fields on the session state. Those
   * are rendered into the `### recalled` and `### memory-index`
   * sections of every step's prompt without touching the stable prefix.
   *
   * The provider is expected to:
   *  - Run BM25 recall for the top-K notes against `userMessage` plus
   *    recent tool-result summaries when present.
   *  - List the compact memory index (most recent pointers).
   *  - Deduplicate: entries returned in `recalled` must not reappear in
   *    `index`, and vice versa — the renderer does no dedup itself.
   *
   * Errors and timeouts are the provider's responsibility; the loop
   * never awaits longer than a few hundred ms in practice and will
   * silently skip injection if the provider throws.
   */
  memoryContextProvider?: MemoryContextProvider;
  /**
   * Optional end-of-turn memory reflection. When present, the loop
   * fires `reflect({ sessionId, userMessage, assistantReply })` in
   * the background once the reply is ready — never awaited, never
   * allowed to throw. Race protection between fires on the same
   * session is enforced INSIDE `ReflectionRunner.runOne` (the new
   * reflect call aborts the previous controller for the same
   * sessionId before starting), so the agent loop does NOT call
   * `abortPending` per turn — see commit message / [PR ref] for the
   * abort-race fix. Shutdown still calls `abortPending()` with no
   * sessionId to drain everything in flight.
   * The loop knows nothing about prompts, grammars, or slot IDs; all of
   * that lives in `src/memory/reflection/`.
   */
  reflectionRunner?: ReflectionRunner;
  /**
   * v2.5 (Phase B — config v18). Sliding-window
   * reflection segmentation. When present and `enabled`, the loop
   * fires `reflectionRunner.reflect(...)` only every
   * `triggerEveryTurns` turns (or unconditionally on `reason: "finish"`
   * — the final-flush invariant). Each fire packs the last
   * `windowTurns` user/assistant pairs into `ReflectionInput.transcript`
   * so the model can extract durable signal across topic-cohesive
   * episodes instead of per-pair micro-reflections.
   *
   * When absent or `enabled === false`, the loop falls back to the
   * legacy per-reply trigger and the single-pair prompt (byte-stable
   * with pre-config-v18 callers).
   */
  reflectionSegmentation?: ReflectionSegmentationConfig;
  /**
   * Memory-v2 phase 6 — lesson lifecycle hook.
   *
   * Invoked exactly once at the end of every `runTurn` with the
   * union of lesson ids that were surfaced into `### lessons`
   * across the turn (`state.recalledLessons` may be refreshed
   * per-step) and the terminal reason. Cross-phase invariants:
   *
   *  - **Once per turn, deduplicated.** Even if the same lesson
   *    surfaced on multiple steps, the bump fires exactly once.
   *  - **No bump for cancelled / max_steps.** Those are neither
   *    success nor failure signals; phase 7a may revisit
   *    `max_steps` as a soft negative once vote curation lands.
   *  - **Fire-safe.** The hook is invoked synchronously after
   *    `turn_finished` is emitted; errors are swallowed by the
   *    caller so a sqlite hiccup never derails the return path.
   *
   * Pinned by `agent-loop-lesson-lifecycle.test.ts`.
   */
  lessonLifecycle?: LessonLifecycleHook;
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * Out-of-band channel for user messages that arrive while this turn is
   * already running (`SteeringInbox`). Drained at the top of every step
   * and folded into that step's `### notice`; see §"Mid-turn steering"
   * in AGENTS.md. Absent in tests and in surfaces that do not offer
   * steering, in which case the loop behaves exactly as before.
   */
  steeringInbox?: SteeringChannel;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
}

/**
 * v2.5 (Phase B — config v18). Runtime knobs for
 * sliding-window reflection segmentation. `triggerEveryTurns` is the
 * cadence (every Nth turn fires; the rest are deferred), `windowTurns`
 * is the size of the user/assistant pair window packed into the
 * reflection prompt. Both must be `>= 1`.
 */
export interface ReflectionSegmentationConfig {
  enabled: boolean;
  triggerEveryTurns: number;
  windowTurns: number;
}

/**
 * The per-link wire shape a pinned turn is built for — the same four
 * facts `AgentLoopDependencies` carries for the active provider, resolved
 * for the pinned one instead. See `AgentLoopDependencies.resolveLlmSlice`.
 */
export interface ResolvedTurnLlmSlice {
  toolTransport: ToolCallTransport;
  toolCallAdapter: ToolCallAdapter | null;
  supportsSlotAffinity: boolean;
  supportsParallelTools: boolean;
}

export interface MemoryContextProviderInput {
  sessionId: string;
  userMessage: string | null;
  toolResultSummaries?: readonly string[];
  signal: AbortSignal;
  /**
   * v2.5 (Phase A — config v18). Trailing
   * user/assistant exchanges projected from `SessionState.turns`,
   * supplied by the agent loop. Decorators (e.g. the heuristic-gated
   * query rewriter under `src/memory/retrieve/`) read this field to
   * resolve referential follow-ups against the recent context.
   *
   * The default provider ignores this field — older callers stay
   * byte-stable. The list does NOT include the just-arrived user
   * message — that is in `userMessage` instead.
   */
  recentTurns?: readonly { role: "user" | "assistant"; text: string }[];
}

export interface MemoryContext {
  recalled: readonly MemoryEntry[];
  index: readonly MemoryIndexEntry[];
  /**
   * Memory-v2 phase 5. Top-K pointer rows from `LessonStore` for the
   * current turn. Optional so phase 1A/B/2/3/4 providers stay
   * source-compatible — missing field is treated as "no lessons".
   */
  lessons?: readonly LessonIndexEntry[];
  /**
   * Memory-v2 phase 7b. Top-K pointer rows from `ProcedureStore`
   * for the current turn. Optional so older providers stay
   * source-compatible. Rendered as `### procedures` between
   * `### lessons` and `### memory-index` in the variable tail.
   */
  procedures?: readonly ProcedureIndexEntry[];
}

export interface MemoryContextProvider {
  buildMemoryContext(
    input: MemoryContextProviderInput,
  ): Promise<MemoryContext> | MemoryContext;
}

/**
 * Memory-v2 phase 6. Outcome signal for `LessonLifecycleHook`.
 * `reply` and `finish` are positive; `failed` is negative;
 * `cancelled` / `max_steps` are filtered out by the caller before
 * invoking the hook (so implementations only see informative
 * outcomes).
 */
export type LessonLifecycleOutcome = "success" | "failure";

export interface LessonLifecycleHook {
  /**
   * Bump `success_count` / `failure_count` for each surfaced lesson
   * id, once per turn. Implementations must be idempotent — the
   * loop deduplicates ids before invoking the hook, but a
   * paranoid implementation is welcome to dedupe again.
   */
  recordTurnOutcome(args: {
    sessionId: string;
    surfacedLessonIds: readonly number[];
    outcome: LessonLifecycleOutcome;
  }): void;
}

/**
 * The turn's side of the steering inbox. Declared structurally (like
 * {@link MemoryContextProvider}) so `src/agent/` does not import from
 * `src/runtime/`, which imports it.
 *
 * The loop owns the window in which steering is accepted: `open` when
 * the turn starts, `drain` at every step boundary, `closeAndDrain`
 * exactly once on the way out. `closeAndDrain` is what makes "the turn
 * can still pick messages up" and "the last drain has happened" the
 * same fact — see the comment on `SteeringInbox.accepting`.
 */
export interface SteeringChannel {
  open(sessionId: string): void;
  drain(sessionId: string): readonly string[];
  closeAndDrain(sessionId: string): readonly string[];
}

/**
 * What the user reads when the step loop ran out before the model
 * finished the task.
 *
 * The old text was `(stopped: max_steps reached without a reply)` — a
 * parenthetical naming an internal counter, offering nothing. Someone
 * watching a browser job stop after three minutes had no way to tell a
 * crash from a budget, and nothing to do about it but retype the task,
 * which starts it over. This says which ceiling was hit, how far the
 * work got, and that "continue" resumes from here rather than restarts.
 */
/**
 * Is this failure the kind that fixes itself?
 *
 * `transport` is a broad category — it is also what a wrong
 * `localModels.url` answering 404, a dead API key (401) and a
 * not-installed CLI provider classify as, because all of them mean
 * "this link is unusable, fall over". None of those become usable by
 * waiting, and parking a turn for five minutes in front of a typo is
 * worse than the failure it replaces: the operator gets no message at
 * all until the budget runs out.
 *
 * So the wait is for the failures that plausibly recover on their own —
 * no HTTP response at all (DNS, refused connection, TLS, socket reset),
 * a server error, or the server saying "busy, later" (408 / 429).
 */
function isWaitableOutage(err: unknown): boolean {
  if (!(err instanceof TransportError)) {
    // An untyped socket failure that reached the classifier through
    // `isNetworkError` — no status to inspect, and by construction it is
    // a connection problem rather than a rejection.
    return true;
  }
  if (err.status === null) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

/** First backoff after the provider stops answering. */
const PROVIDER_WAIT_BASE_MS = 2_000;
/**
 * Ceiling on one backoff. An outage lasting minutes should be probed
 * every half-minute, not once an hour — the point is to notice the
 * moment it comes back.
 */
const PROVIDER_WAIT_MAX_BACKOFF_MS = 30_000;

/** Sleep that returns early when the operator aborts the turn. */
async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function formatTaskStoppedReply(input: {
  cause: "step_ceiling" | "time_ceiling" | "no_progress";
  stepsTaken: number;
  stepCeiling: number;
  elapsedMs: number;
}): string {
  const minutes = Math.max(1, Math.round(input.elapsedMs / 60_000));
  const spent = `${input.stepsTaken} steps over ~${minutes} min`;
  const head =
    input.cause === "time_ceiling"
      ? `(paused: this task hit its time limit after ${spent}.)`
      : input.cause === "no_progress"
        ? `(paused: nothing came back from my last ${spent} of tool calls — something in the environment is failing.)`
        : `(paused: this task hit its step ceiling of ${input.stepCeiling} after ${spent}.)`;
  const tail =
    input.cause === "no_progress"
      ? "Here is where I got to. Check the failing tool or connection, then say `continue`."
      : "Here is where I got to — the work so far is kept in this session. Say `continue` to pick up from here, or raise `agent.task.maxSteps` for longer runs.";
  return `${head} ${tail}`;
}

export interface RunTurnOptions {
  /**
   * Steps in one leg — the checkpoint interval, not the end of the work.
   * The loop reports progress here and carries on; what ends a task is
   * `taskMaxSteps` / `taskMaxDurationMs` (or the model finishing).
   */
  maxSteps: number;
  /**
   * Hard ceiling on steps for this task. Defaults to
   * `config.agent.task.maxSteps`; a durable task record passes its own.
   */
  taskMaxSteps?: number;
  /** Wall-clock ceiling. Defaults to `config.agent.task.maxDurationMs`. */
  taskMaxDurationMs?: number;
  /**
   * Carry on past a leg boundary while the work progresses. Defaults to
   * `config.agent.task.autoContinue`; `false` restores the historical
   * "stop at `maxSteps`" behaviour for a caller that wants one leg only.
   */
  autoContinue?: boolean;
  /**
   * Wait out a provider outage instead of failing the turn. Defaults to
   * `config.agent.providerWait.enabled`; `false` is the old behaviour.
   */
  providerWaitEnabled?: boolean;
  /** Wait budget for one outage. Defaults to `config.agent.providerWait.maxWaitMs`. */
  providerWaitMaxMs?: number;
  signal: AbortSignal;
  /** Optional new user message to append before stepping. */
  userMessage?: string;
  /**
   * Pin every completion of this turn to one configured provider id.
   * The step is built for that link's transport (via
   * `AgentLoopDependencies.resolveLlmSlice`) and the request bypasses
   * the fallback chain (see `LlmStreamParams.providerId`). A fusion
   * worker turn sets this to the local leg while the orchestrator turn
   * on the parent session keeps the active (cloud) provider.
   */
  providerId?: string;
  /**
   * The turn leaves no durable trace in the memory fabric: no recall or
   * per-step memory refresh, no end-of-turn reflection, no lesson
   * lifecycle bump. For fusion worker sessions — throwaway state whose
   * transcript the orchestrator reads once and discards; letting it
   * reflect would write the worker's half-context into the operator's
   * long-term memory. Mid-turn steering is unaffected.
   */
  ephemeral?: boolean;
  /**
   * Hide tools from this turn. Applied to the descriptors handed to every
   * step, composed with the finalization-step filter, so under native
   * tools the hidden tool also leaves the wire payload — the step builds
   * `tools` from the same descriptors. The two terminal tools are the
   * exception: the OpenAI adapter appends `reply` / `finish` to the wire
   * unconditionally, so filtering them only hides them from the prompt
   * catalog. Used to keep a worker from delegating further, scheduling,
   * or writing memory.
   */
  toolFilter?: (name: string) => boolean;
}

/** Why a `runTurn` invocation returned. */
export type AgentLoopReason =
  "reply" | "finish" | "max_steps" | "cancelled" | "failed";

export type AgentLoopEvent =
  | { type: "user_message"; text: string }
  /**
   * A message the user sent mid-turn was folded into the prompt for
   * step `stepIndex`. Distinct from `user_message`, which marks the
   * message that *started* the turn — UIs render this one inline in the
   * running turn rather than as the opening of a new one.
   */
  | { type: "steer_applied"; text: string; stepIndex: number }
  | { type: "turn_started"; turnIndex: number }
  | {
      type: "turn_finished";
      turnIndex: number;
      reason: AgentLoopReason;
      stepCount: number;
      durationMs: number;
    }
  | {
      /**
       * The provider stopped answering and the turn is parked rather
       * than failed: the same step will be retried after `nextRetryMs`.
       * Fired once per wait, so a UI can show a live "waiting" state
       * instead of nine mystery failures in a row.
       */
      type: "provider_waiting";
      attempt: number;
      waitedMs: number;
      maxWaitMs: number;
      nextRetryMs: number;
      reason: string;
    }
  | {
      /** The provider answered again; the parked turn is running on. */
      type: "provider_recovered";
      waitedMs: number;
    }
  | {
      /**
       * The completion for step `stepIndex` came back cut off, and the
       * same step is being retried with a different request: a larger
       * reply cap, or a prompt re-packed to the context window the
       * server just revealed. Fired once per retry; a second cut on the
       * same step fails the turn with the cause in the message.
       */
      type: "completion_truncated";
      stepIndex: number;
      cause: TruncationCause;
      completionTokens: number;
      promptTokens: number;
      requestedMaxTokens: number;
      retry: TruncationRetry;
    }
  | {
      /**
       * The completion for step `stepIndex` could not be parsed into
       * tool calls, and the turn is spending another step on it instead
       * of ending: the next prompt carries a `### notice` naming the
       * rejection. Fired once per recovery; `attempt` counts them within
       * the turn, `budget` is the ceiling after which the turn fails.
       */
      type: "parse_failure_recovered";
      stepIndex: number;
      attempt: number;
      budget: number;
      reason: string;
    }
  | {
      /**
       * The completion for step `stepIndex` came back with nothing in
       * any channel, and the turn is spending another step on it rather
       * than ending: the next prompt carries a `### notice` saying the
       * reply was empty. Its own type rather than a
       * `parse_failure_recovered` with an odd reason — there was no
       * output to reject, and the operator line has to say so.
       */
      type: "empty_completion_recovered";
      stepIndex: number;
      attempt: number;
      budget: number;
    }
  | {
      /**
       * A leg of the task finished and the work is continuing. Fired at
       * every `maxSteps` boundary that does not end the task, so a long
       * job reports itself instead of going quiet for an hour.
       */
      type: "task_continued";
      stepsTaken: number;
      elapsedMs: number;
      stepCeiling: number;
    }
  | {
      /**
       * One leg of a fusion turn started, ran a tool, ended, or was cut
       * short. Emitted by `fusion.delegate` in the PARENT session's
       * frame, never a worker's: a worker session has no recorder, no
       * event hook and no UI, so an event tagged with its id would reach
       * nobody. This is the only window the operator has into a fan-out
       * that can occupy the orchestrator's turn for minutes.
       *
       * Not produced by `AgentLoop` itself — it rides this union because
       * the runtime's event fan-out and every UI reducer are typed on it.
       */
      type: "fusion_worker";
      taskId: string;
      title: string;
      phase: "started" | "tool" | "finished" | "failed" | "cancelled";
      /**
       * Which leg this line is about. `worker` when absent, so the
       * event's original shape still reads correctly. The orchestrator
       * uses it to claim its own `fusion.delegate` call: without it the
       * whole fan-out block reads as if nothing but workers ran.
       */
      role?: "worker" | "orchestrator";
      /**
       * The model this leg is running — `runMode.workerModel` /
       * `.orchestratorModel`, falling back to the provider id when the
       * resolver has no label. Never a guess: a UI that invented a name
       * here would be attributing spend to the wrong model.
       */
      model?: string;
      /** `phase: "tool"` only: the tool this leg just started. */
      tool?: string;
      stepCount?: number;
      durationMs?: number;
      /** One line about the outcome; the worker's reply, clipped. */
      summary?: string;
    }
  | { type: "step_started"; stepIndex: number }
  | {
      type: "step_finished";
      stepIndex: number;
      summary: string;
      durationMs: number;
    }
  | { type: "llm_event"; event: StepEvent }
  | {
      /**
       * Fired once per detected no-progress run. Carries the tool name and
       * the length of the identical-step streak. The runtime will inject a
       * one-shot notice into the next prompt; UIs can use this event to
       * flag the turn visually.
       */
      type: "loop_detected";
      tool: string;
      count: number;
      stepIndex: number;
      /** Graduated severity from the `ToolLoopTracker`. */
      level?: "warn" | "critical" | "breaker";
      /** Which sub-detector fired. */
      detector?:
        | "generic_repeat"
        | "no_progress"
        | "wandering"
        | "test_repeat"
        | "read_repeat";
      /**
       * `read_repeat` only: the resolved file, the range that read
       * returned, and the fingerprint on either side of it (equal ⇒ the
       * content did not change, which is what makes the read redundant).
       * Line numbers and a path — never file content.
       */
      read?: {
        path: string;
        startLine: number;
        endLine: number;
        previousFingerprint: string;
        fingerprint: string;
      };
    }
  | {
      type: "loop_completed";
      reason: AgentLoopReason;
    }
  /**
   * Terminal failure for the turn. `category` follows the canonical
   * LLM-failure taxonomy (see `src/llm/reliability/`); downstream
   * consumers never need to classify the error themselves.
   */
  | { type: "loop_failed"; error: Error; category: LlmFailureCategory }
  /**
   * The provider fallback chain changed the active provider for this
   * turn. `direction: "away"` = the primary was unreachable and we
   * switched to a fallback; `direction: "back"` = a throttled probe found
   * the primary healthy again and we returned to it. Emitted at most once
   * per state transition (never on sticky turns). See AGENTS.md
   * §"Provider fallback chain".
   */
  | {
      type: "provider_switched";
      direction: "away" | "back";
      from: string;
      to: string;
      reason: string;
    };

export interface RunTurnResult {
  session: SessionState;
  reason: AgentLoopReason;
  stepCount: number;
  /**
   * Steering messages that were pushed but never reached a step — the
   * turn ended (or was cancelled) before the loop could drain them.
   * Callers MUST re-route these, normally onto their own message queue,
   * otherwise a message the user watched being accepted vanishes. Empty
   * on every ordinary turn.
   */
  undelivered?: readonly string[];
}

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDependencies) {}

  /**
   * Whether the local llama-server is the route this turn takes. No gate
   * wired (test / legacy deps) reads as `true` so the profile manager
   * behaves exactly as it did before issue #112.
   */
  private localBackendActive(): boolean {
    return this.deps.localBackend?.isActive() ?? true;
  }

  /**
   * Drive one macro-turn:
   *   user message → 0..N tool steps → `reply` (or `finish` / max_steps).
   *
   * The loop:
   *  - Appends the user message (when supplied) to the transcript.
   *  - Executes steps until a terminal tool is emitted or the budget runs out.
   *  - On `reply`: returns with `reason: "reply"`, session stays open.
   *  - On `finish`: returns with `reason: "finish"`, session marked completed.
   *  - On `max_steps`: synthesises a fallback assistant reply so the user
   *    is never left without a turn closing.
   *
   * The wrapper owns the mid-turn steering window: it is open for
   * exactly the lifetime of this call, and it closes in the same
   * indivisible step as the loop's final drain (see `flushSteering`).
   * A `steer()` that lands after that is refused, not stranded.
   */
  async runTurn(
    session: SessionState,
    options: RunTurnOptions,
  ): Promise<RunTurnResult> {
    this.deps.steeringInbox?.open(session.id);
    try {
      return await this.runTurnInner(session, options);
    } finally {
      // Every ordinary exit already closed the window through
      // `flushSteering` — a `return` expression is evaluated before
      // this block runs, so `undelivered` is unaffected and this call
      // is a no-op. What it catches is the throw path (a programming
      // bug escaping the classified-error handling above): without it
      // the session would stay open forever and every later `steer()`
      // would be accepted into an inbox nobody drains.
      const stranded = this.deps.steeringInbox?.closeAndDrain(session.id) ?? [];
      if (stranded.length > 0) {
        this.deps.logger?.warn("mid-turn steering stranded by a failed turn", {
          sessionId: session.id,
          count: stranded.length,
        });
      }
    }
  }

  private async runTurnInner(
    session: SessionState,
    options: RunTurnOptions,
  ): Promise<RunTurnResult> {
    let state = session;

    // NOTE: previously called `reflectionRunner.abortPending({ sessionId })`
    // here on every turn to "free the reflection slot quickly". That
    // was over-aggressive: reflection fires only every Nth turn under
    // segmentation, but the abort fired on every turn — so reflection
    // from turn K was reliably cancelled at the start of turn K+1
    // (within ~5ms of being fired, before the LLM call could even
    // respond). Net effect: in 75-turn LoCoMo runs, 0 reflection
    // writes landed. Confirmed via debug instrumentation in
    // `reflection-runner.ts` — see commit message / [PR ref] for the
    // 6-prompt e2e probe that pinned the race.
    //
    // The race-prevention contract is already enforced INSIDE
    // `ReflectionRunner.runOne`: when a NEW reflect() is about to
    // start for the same session, it aborts the previous controller
    // first (see `previous?.abort()` in `runOne`). Reflection writes
    // are additive, so a late-landing write from turn K landing
    // during turn K+2 is harmless — the next prompt-build sees the
    // strictly larger memory set.
    //
    // Shutdown path still calls `abortPending()` with no sessionId
    // before the runtime tears down SQLite handles. Note that it
    // *signals* — nothing is awaited, so a reflection can still be
    // resuming when the stores close. That is why the decorators and
    // this call site guard their store reads rather than relying on
    // the abort to have finished.

    if (options.userMessage !== undefined) {
      const text = options.userMessage;
      state = recordTurn(state, userTurn(text));
      this.deps.onEvent?.({ type: "user_message", text });
    }

    const turnIndex = state.turnCount;
    this.deps.onEvent?.({ type: "turn_started", turnIndex });
    const turnStartedAt = Date.now();

    // A pinned turn is built for the pinned link's wire shape. Resolved
    // once: the pin does not move during a turn, and the global getters
    // below describe the ACTIVE provider, which is the wrong one here.
    const pinnedSlice =
      options.providerId !== undefined && this.deps.resolveLlmSlice
        ? this.deps.resolveLlmSlice(options.providerId)
        : null;
    const visibleToolDescriptors = (): readonly ToolDescriptor[] => {
      const filter = options.toolFilter;
      return filter
        ? this.deps.toolDescriptors.filter(({ name }) => filter(name))
        : this.deps.toolDescriptors;
    };

    state = await refreshMemoryContext(this.deps, state, options);

    // Proactively sync with the live `llama-server` before the first
    // step. Catches the case where the operator swapped the model
    // between turns — without this, step 0 would still build the prompt
    // with the previous model's template. Skipped whole on a cloud turn
    // (issue #112): there is no llama-server behind the prompt to sync
    // with, and the probe would fail against a backend nobody is using.
    //
    // ...unless the previous turn was actually SERVED by a local link
    // through the fallback chain. `appendLocal` defaults to `true`, so a
    // rate-limited cloud primary falls over to llama-server on every
    // turn while the active provider stays cloud; without this second
    // arm the profile and grammar would stay pinned to whatever the
    // first fallover probed for the whole outage. Take-and-clear, so a
    // recovered primary quiets the probes again after one turn.
    const localLinkServedLastTurn =
      this.deps.localBackend?.takeLinkServed?.() ?? false;
    if (this.deps.profileManager) {
      if (this.localBackendActive()) {
        if (!(await this.deps.localBackend?.ensureProbed())) {
          await this.deps.profileManager.refresh();
        }
      } else if (localLinkServedLastTurn) {
        await this.deps.profileManager.refresh();
      }
    }

    // Fusion's division of labour is per TURN, not per session: each
    // turn starts owing a plan and a fan-out before it may write. An
    // ephemeral turn is a worker's own — the gate is the orchestrator's
    // and must never close on the hands it is meant to free.
    const fusionOrchestratorTurn =
      (this.deps.isFusionMode?.() ?? false) && options.ephemeral !== true;
    let fusionDelegatedThisTurn = false;

    let reason: AgentLoopReason = "max_steps";
    let stepsTaken = 0;
    let runError: Error | null = null;
    // What the user asked for is a *task*: "register on these ten sites"
    // is one goal made of hundreds of steps. A step count is the wrong
    // thing to end it with, so `maxSteps` is only the length of a leg —
    // the loop checks in at each boundary, says where it is, and keeps
    // going while the work progresses. These are the ceilings that
    // actually stop it.
    const taskCfg = getConfig().agent.task;
    const legSteps = Math.max(1, options.maxSteps);
    const autoContinue = options.autoContinue ?? taskCfg.autoContinue;
    // Without auto-continue the ceiling IS the leg: one leg, then stop,
    // exactly as before this existed.
    const stepCeiling = autoContinue
      ? Math.max(legSteps, options.taskMaxSteps ?? taskCfg.maxSteps)
      : legSteps;
    const durationCeilingMs =
      options.taskMaxDurationMs ?? taskCfg.maxDurationMs;
    const taskStartedAt = Date.now();
    /**
     * Why the task stopped, when the step loop ran out rather than the
     * model finishing. Drives the closing message: "ran out of steps"
     * and "made no progress for a whole leg" are different things to
     * tell someone, and the old single `max_steps` string said neither.
     */
    let stopCause: "step_ceiling" | "time_ceiling" | "no_progress" =
      "step_ceiling";
    /** Set by any step in the current leg that produced a usable result. */
    let legMadeProgress = false;
    // Provider-outage parking. A transport failure means "this link is
    // not answering", which is a state of the world, not a verdict on
    // the turn — so the turn waits for it rather than dying and taking
    // the work in flight with it. Reset after a recovery so a second
    // outage later in a long task gets its own budget; the task's
    // wall-clock ceiling is what bounds the total.
    const providerWaitDefaults = getConfig().agent.providerWait;
    const providerWaitCfg = {
      enabled: options.providerWaitEnabled ?? providerWaitDefaults.enabled,
      maxWaitMs: options.providerWaitMaxMs ?? providerWaitDefaults.maxWaitMs,
    };
    let outageWaitedMs = 0;
    let outageAttempts = 0;
    /** Retried a step after an outage and have not yet seen it succeed. */
    let awaitingRecovery = false;
    // Truncation retry. A reply the server cut short is not a verdict on
    // the step either — but unlike an outage, replaying the same request
    // is pointless, so the retry changes it: a larger reply cap when the
    // cap was spent, a re-packed prompt when the window filled. One
    // retry per step index; the second cut ends the turn.
    // Declared through a cast rather than a `null` literal: the literal
    // narrows the binding to `null`, and the catch clause below — which
    // TypeScript enters from the start of the `try`, before the loop's
    // back-edge from this very clause is folded in — then reads it as
    // `never`.
    let truncationRetry = null as {
      stepIndex: number;
      maxTokens?: number;
      /** The truncation that started the retry, for the message if the retry is refused. */
      original: Error;
    } | null;
    /**
     * The step index whose leg boundary already ran. A retried step
     * (outage or truncation) re-enters the loop at the same index; the
     * boundary must not run twice, or its progress flag — reset by the
     * first pass — reads the retry as a whole leg with nothing to show.
     */
    let lastBoundaryIndex = -1;
    /**
     * Completions this turn that came back unparseable and were spent
     * another step on. Bounded by `PARSE_RECOVERY_BUDGET`: a model that
     * cannot emit a valid tool call twice in a row will not manage it on
     * the third try either, and the operator is owed the failure.
     */
    let parseRecoveries = 0;
    /**
     * Empty completions spent another step on, counted only while they
     * are CONSECUTIVE — any completion that carried something resets it
     * (see the reset next to `stepsTaken += 1` below). Bounded by
     * `EMPTY_COMPLETION_RECOVERY_BUDGET`, and separate from
     * `parseRecoveries` because the two shapes are different evidence:
     * an unparseable body is a model that tried, an empty one is a model
     * that emitted no tokens at all.
     */
    let emptyRecoveries = 0;
    /**
     * Is there a step left for a recovery to actually be spent in?
     *
     * A recovery that "spends a step" is a promise of another
     * inference: the operator is told the turn is trying again, and the
     * failure is dropped on the strength of that. The LEG boundary is
     * the one ceiling that can make that promise entirely false, and it
     * is the one this predicate exists for. A recovery taken on the
     * final step of a leg that has produced nothing usable lands on the
     * `no_progress` break, which leaves the loop before `executeStep`
     * runs again: the announced retry never happens, the step is burnt
     * for nothing, and the model diagnosis is swallowed into "ran out
     * of steps" — taking the error report with it, since only
     * `loop_failed` is captured.
     *
     * The step and duration ceilings are deliberately NOT solved here.
     * The finalization guard preempts a recovery on a step that is
     * already final, but nothing stops one from LANDING on the final
     * step — and there the retry genuinely runs, so refusing it would
     * forfeit a real inference (and, on the last step of a long task,
     * the summary it might still produce). What that case needs is for
     * its failure to be reported instead of swallowed, which is
     * `repeatedEmptyAfterAnnouncedRetry` in the catch below. The
     * `stepCeiling` test that follows is therefore only a floor: it
     * rejects a retry with no step at all left to run in, which the
     * finalization guard already makes unreachable.
     *
     * Reading `legMadeProgress` here is reading exactly what the
     * boundary will read: a recovery cannot set it (it produced nothing
     * usable, by definition), and nothing else runs in between.
     */
    const recoveryStepAvailable = (stepIndex: number): boolean => {
      const next = stepIndex + 1;
      if (next >= stepCeiling) return false;
      const boundaryRuns =
        next > 0 && next % legSteps === 0 && next !== lastBoundaryIndex;
      return !boundaryRuns || legMadeProgress;
    };
    // Per-turn no-progress loop tracker (OpenClaw-style). Threaded into
    // `executeStep` so the synchronous batch gate can veto looping calls
    // before they are dispatched; the agent loop consumes the resulting
    // `loopSignals` after each step to inject notices and trigger the
    // graceful breaker termination.
    const agentCfg = getConfig().agent;
    const loopTracker = new ToolLoopTracker({
      warningThreshold: agentCfg.loopWarningThreshold,
      criticalThreshold: agentCfg.loopCriticalThreshold,
      breakerVetoStreak: agentCfg.loopBreakerVetoStreak,
      historySize: agentCfg.loopHistorySize,
      wanderingThreshold: agentCfg.loopWanderingThreshold,
      wanderingEscalation: agentCfg.loopWanderingEscalation,
    });
    // Memory-v2 phase 6 — accumulate the union of lesson ids surfaced
    // across every step of this turn. `refreshMemoryContext` may
    // recompute `state.recalledLessons` per step; we record each new
    // id as it lands so the lifecycle hook fires once-per-turn-per-id
    // even when the same lesson keeps re-surfacing.
    const surfacedLessonIds = new Set<number>();
    const recordSurfacedLessons = (s: SessionState): void => {
      for (const l of s.recalledLessons ?? []) {
        surfacedLessonIds.add(l.id);
      }
    };
    recordSurfacedLessons(state);
    // Memory-v2 phase 7b — same accumulator, but for procedure ids.
    // Surfaces into the vote-runner allowlist so the LLM can only
    // vote on procedures it actually saw in `### procedures`.
    const surfacedProcedureIds = new Set<number>();
    const recordSurfacedProcedures = (s: SessionState): void => {
      for (const p of s.recalledProcedures ?? []) {
        surfacedProcedureIds.add(p.id);
      }
    };
    recordSurfacedProcedures(state);
    // One-shot notice injected into the NEXT step's prompt only. Cleared
    // as soon as it is consumed so the stable tail does not carry stale
    // nudges across steps.
    let pendingNotice: string | undefined;

    state = { ...state, status: "running" };

    // The step loop below is where coding work actually happens. On each
    // step the model sees the freshly built prompt (transcript + tool
    // catalog + memory tail) and either emits tool calls — reading files,
    // editing, running commands through the approval gate — or a terminal
    // `reply`/`finish`. Tool results are appended to the conversation, so
    // the next step's prompt carries everything the previous step learned.
    for (let i = 0; i < stepCeiling; i += 1) {
      if (options.signal.aborted) {
        reason = "cancelled";
        break;
      }
      // Leg boundary. Everything the task needs to keep running is
      // decided here, once per `legSteps` steps, and never mid-leg.
      if (i > 0 && i % legSteps === 0 && i !== lastBoundaryIndex) {
        lastBoundaryIndex = i;
        if (!legMadeProgress) {
          // A whole leg with nothing usable coming back is the honest
          // place to stop: the loop detector's breaker catches a model
          // repeating itself, but not a model whose every call fails.
          stopCause = "no_progress";
          reason = "max_steps";
          break;
        }
        legMadeProgress = false;
        this.deps.onEvent?.({
          type: "task_continued",
          stepsTaken,
          elapsedMs: Date.now() - taskStartedAt,
          stepCeiling,
        });
        this.deps.logger?.info("task leg finished; continuing", {
          sessionId: state.id,
          stepsTaken,
          stepCeiling,
          elapsedMs: Date.now() - taskStartedAt,
        });
      }
      // Reactive refresh between steps: if the previous completion
      // observed a foreign `modelId`, rebuild profile + grammar so the
      // next prompt matches what `llama-server` is actually serving.
      // Same cloud-turn gate as the turn-start refresh (issue #112).
      // Nothing is lost on a cloud turn that falls over: the fallback
      // seam's `prepareLink` runs this same `refreshIfStale` for a
      // `llama-server` link at the point the link is picked, which is
      // strictly later than here and strictly closer to the request —
      // the completion that flagged the manager stale may not even have
      // happened yet when this line runs.
      if (this.deps.profileManager && this.localBackendActive()) {
        if (!(await this.deps.localBackend?.ensureProbed())) {
          await this.deps.profileManager.refreshIfStale();
        }
      }
      this.deps.onEvent?.({ type: "step_started", stepIndex: i });
      const started = Date.now();
      // Mid-turn steering: anything the user sent since the previous
      // step boundary joins this step's prompt. It is recorded as a
      // real `user` turn (the transcript must reflect what was said,
      // and `packConversation` always keeps the last user turn visible)
      // AND repeated in `### notice`, which is the tail-most block the
      // model reads before `### respond`. `composeSteerNotice` appends
      // to whatever the loop detector already left in `pendingNotice`
      // rather than overwriting it — both nudges matter.
      const steered = this.deps.steeringInbox?.drain(state.id) ?? [];
      for (const text of steered) {
        state = recordTurn(state, userTurn(text));
        this.deps.onEvent?.({ type: "steer_applied", text, stepIndex: i });
      }
      if (steered.length > 0) {
        pendingNotice = composeSteerNotice(pendingNotice, steered);
        this.deps.logger?.info("mid-turn steering applied", {
          sessionId: state.id,
          stepIndex: i,
          count: steered.length,
        });
      }
      const noticeForThisStep = pendingNotice;
      pendingNotice = undefined;
      // On the final allowed step the tool catalog collapses to the two
      // terminal tools, so a long coding session ends with a summary of
      // what was changed instead of being cut off mid-edit.
      // One step is always reserved for a summary, whichever ceiling is
      // about to bite — being cut off mid-edit is what made the old
      // stop unreadable.
      const outOfTime = Date.now() - taskStartedAt >= durationCeilingMs;
      if (outOfTime) stopCause = "time_ceiling";
      const finalizationStep = i === stepCeiling - 1 || outOfTime;
      const finalizationNotice =
        "This is the final allowed step. Do not call any non-terminal tool; " +
        "summarize the completed work with reply, or end the session with finish.";
      try {
        // `profileFactsProvider` is a raw `profileStore.list()`.
        // Dropping the facts is a real loss — `profile-renderer` emits
        // pinned facts regardless of the contextual gate, so this step
        // renders with no `### profile` section at all — but it is the
        // lesser one: a throw here lands in the
        // catch below, where a `TypeError` from a closed SQLite handle
        // classifies `tool` and fails the turn outright.
        let profileFacts: readonly ProfileFact[] | undefined;
        try {
          profileFacts = this.deps.profileFactsProvider?.();
        } catch (err) {
          this.deps.logger?.warn("profile facts unavailable for this step", {
            sessionId: state.id,
            stepIndex: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const activeProfile =
          this.deps.profileManager?.getProfile() ??
          this.deps.profile ??
          PLAIN_INSTRUCT_PROFILE;
        const activeGrammar =
          this.deps.profileManager?.getGrammar() ?? this.deps.grammar;
        const outcome = await executeStep(
          {
            session: state,
            toolDescriptors: finalizationStep
              ? visibleToolDescriptors().filter(
                  ({ name }) => name === "reply" || name === "finish",
                )
              : visibleToolDescriptors(),
            capabilities: this.deps.capabilities,
            skillCatalog: this.deps.skillCatalog,
            stepIndex: i,
            signal: options.signal,
            ...(finalizationStep || noticeForThisStep !== undefined
              ? {
                  transientNotice: [
                    noticeForThisStep,
                    ...(finalizationStep ? [finalizationNotice] : []),
                  ]
                    .filter((notice): notice is string => notice !== undefined)
                    .join("\n\n"),
                }
              : {}),
            ...(finalizationStep ? { terminalOnly: true } : {}),
            ...(truncationRetry?.stepIndex === i &&
            truncationRetry.maxTokens !== undefined
              ? { maxTokens: truncationRetry.maxTokens }
              : {}),
            ...(profileFacts !== undefined ? { profileFacts } : {}),
            ...(options.userMessage !== undefined
              ? { userMessage: options.userMessage }
              : {}),
          },
          {
            registry: this.deps.registry,
            ...(this.deps.isPlanMode
              ? { isPlanMode: this.deps.isPlanMode }
              : {}),
            ...(fusionOrchestratorTurn
              ? {
                  isFusionOrchestrator: () => true,
                  hasDelegated: () => fusionDelegatedThisTurn,
                  onDelegated: () => {
                    fusionDelegatedThisTurn = true;
                  },
                }
              : {}),
            slotManager: this.deps.slotManager,
            grammar: activeGrammar,
            profile: activeProfile,
            ...(this.deps.contextWindow
              ? { contextWindow: this.deps.contextWindow() }
              : {}),
            toolTransport:
              pinnedSlice?.toolTransport ??
              this.deps.toolTransport ??
              "grammar",
            toolCallAdapter:
              pinnedSlice?.toolCallAdapter ?? this.deps.toolCallAdapter ?? null,
            supportsSlotAffinity:
              pinnedSlice?.supportsSlotAffinity ??
              this.deps.supportsSlotAffinity ??
              true,
            supportsParallelTools:
              pinnedSlice?.supportsParallelTools ??
              this.deps.supportsParallelTools ??
              true,
            ...(options.providerId !== undefined
              ? { providerId: options.providerId }
              : {}),
            llmComplete: this.deps.llmComplete,
            ...(this.deps.llmCompleteStream
              ? { llmCompleteStream: this.deps.llmCompleteStream }
              : {}),
            ...(this.deps.profileManager
              ? {
                  onCompletion: (completion: CompletionResult) =>
                    this.deps.profileManager?.observeCompletionModelId(
                      completion.modelId,
                    ),
                }
              : {}),
            onEvent: (event) =>
              this.deps.onEvent?.({ type: "llm_event", event }),
            ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
            ...(this.deps.logger ? { logger: this.deps.logger } : {}),
            tracker: loopTracker,
          },
        );
        const durationMs = Date.now() - started;
        if (awaitingRecovery) {
          // The step that came back after the wait. Say so once, then
          // hand the next outage a fresh budget.
          this.deps.onEvent?.({
            type: "provider_recovered",
            waitedMs: outageWaitedMs,
          });
          this.deps.logger?.info("provider answered again; turn resumed", {
            sessionId: state.id,
            stepIndex: i,
            waitedMs: outageWaitedMs,
          });
          awaitingRecovery = false;
          outageWaitedMs = 0;
          outageAttempts = 0;
        }
        state = outcome.nextSession;
        stepsTaken += 1;
        // A completion the step could act on. Whatever run of empty
        // completions was in progress is over: the link has just proved
        // it answers, so an empty one later in this turn is a fresh
        // event and is owed its own retry, and the terminal message can
        // keep saying "twice in a row" and mean it.
        emptyRecoveries = 0;
        const tokensUsed =
          (outcome.completion.timing?.promptTokens ??
            outcome.prompt.tokens.total) +
          (outcome.completion.timing?.predictedTokens ?? 0);
        // The server just held more than the runtime thought it could:
        // a learned window was wrong, and packing to it would only
        // throw context away.
        const believedWindow = this.deps.contextWindow?.() ?? null;
        const usage = outcome.completion.usage;
        if (
          usage !== undefined &&
          believedWindow !== null &&
          usage.promptTokens + usage.completionTokens > believedWindow
        ) {
          this.deps.onContextWindowExceeded?.(
            usage.promptTokens + usage.completionTokens,
          );
        }
        // Step-level outcome rolls up batched results: any failed call
        // marks the step as `error` so metrics catch partial failures.
        const stepStatus: "ok" | "error" = outcome.toolResults.some(
          (r) => r.status === "error",
        )
          ? "error"
          : "ok";
        // Progress for the leg check is "something usable came back",
        // not "the step was clean": a batch where three calls of four
        // succeeded moved the task forward. What it excludes is a leg
        // whose every call failed — a dead tool, a dead network, a
        // rejected approval loop — which is the case worth stopping on.
        if (outcome.toolResults.some((r) => r.status === "ok")) {
          legMadeProgress = true;
        }
        // Feed summary mirrors the legacy single-call shape for solo
        // steps; for a batch we render `N tools: t1, t2, …` so the TUI
        // and trace consumer see at a glance that this was a batch.
        const summary =
          outcome.toolResults.length === 1
            ? outcome.toolResults[0]!.summary
            : `${outcome.toolResults.length} tools: ${outcome.toolResults
                .map((r) => `${r.tool}[${r.status}]`)
                .join(", ")}`;
        this.deps.metrics?.recordStep({
          sessionId: state.id,
          stepIndex: i,
          tokensUsed,
          durationMs,
          outcome: stepStatus,
        });
        this.deps.onEvent?.({
          type: "step_finished",
          stepIndex: i,
          summary,
          durationMs,
        });
        if (outcome.terminal === "session") {
          reason = "finish";
          state = { ...state, status: "completed" };
          break;
        }
        if (outcome.terminal === "turn") {
          reason = "reply";
          break;
        }
        // A trimmed-batch step (auto-split: approval-gated solo) seeds
        // the next step's `pendingNotice` so the model sees which calls
        // were dropped and can retry them as length-1 arrays. The
        // loop-signal path below may overwrite this with a repeat
        // notice — that is intentional: a loop hint outranks a trim
        // hint since the loop indicates the model failed to make
        // progress over multiple steps. A wave-split step (issue #111)
        // seeds its notice the same way — nothing was dropped, but the
        // model should know its oversized read array ran in bounded
        // waves.
        if (outcome.trimmedBatchNotice !== undefined) {
          pendingNotice = outcome.trimmedBatchNotice;
        } else if (outcome.waveSplitNotice !== undefined) {
          pendingNotice = outcome.waveSplitNotice;
        }

        // The synchronous batch gate (inside `executeStep`) already
        // produced graduated loop signals for this step. Terminal verbs
        // are never gated, so `reply`/`finish` steps carry no signals.
        // Additionally feed a composite-batch observation for multi-call
        // steps so two identical batches in a row (whose individual calls
        // each have unique args and therefore never trip the per-call
        // gate) are still flagged — a permuted batch is not (the hash is
        // order-sensitive). Composite hits are advisory only (notice),
        // never a veto: the calls already executed.
        const loopSignals: BatchLoopSignal[] = [...outcome.loopSignals];
        if (outcome.toolCalls.length > 1) {
          const composite = loopTracker.observeBatchComposite(
            outcome.toolCalls.map((call) => ({
              tool: call.tool,
              args: call.args,
            })),
            outcome.toolResults,
          );
          if (composite.level !== "ok") {
            loopSignals.push({
              kind: "warn",
              tool: composite.tool,
              count: composite.count,
              detector: composite.detector,
              warningKey: composite.warningKey,
            });
          }
        }

        // Breaker: the model ignored repeated vetoes of the same call.
        // Force a graceful synthetic reply (NOT a `loop_failed` — the
        // turn ends with a best-effort answer, the session stays usable).
        const breaker = loopSignals.find((s) => s.kind === "breaker");
        if (breaker) {
          const replyText = formatForcedLoopReply(breaker.tool, breaker.count);
          state = recordTurn(state, assistantReplyTurn(replyText));
          this.deps.onEvent?.({
            type: "llm_event",
            event: { type: "assistant_reply", text: replyText },
          });
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: breaker.tool,
            count: breaker.count,
            stepIndex: i,
            level: "breaker",
            detector: breaker.detector,
          });
          this.deps.logger?.warn(
            "no-progress loop breaker tripped; forcing graceful reply",
            {
              sessionId: state.id,
              stepIndex: i,
              tool: breaker.tool,
              count: breaker.count,
            },
          );
          reason = "reply";
          break;
        }

        // Critical vetoes: the synthetic veto result already carries the
        // instruction in the transcript. Surface the event so UIs/traces
        // flag it; no extra notice needed.
        for (const sig of loopSignals) {
          if (sig.kind !== "critical") continue;
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: sig.tool,
            count: sig.count,
            stepIndex: i,
            level: "critical",
            detector: sig.detector,
          });
          this.deps.logger?.warn("no-progress loop: call vetoed", {
            sessionId: state.id,
            stepIndex: i,
            tool: sig.tool,
            count: sig.count,
          });
        }

        // Warn repeats: inject a one-shot `### notice` for the next step,
        // de-duplicated per `warningKey` so the same nudge is not
        // re-injected on every subsequent identical step.
        for (const sig of loopSignals) {
          if (sig.kind !== "warn") continue;
          // Two detectors carry their own floor because their signal is
          // conclusive earlier than a byte-identical repeat is. A 2nd
          // test run against an unchanged workspace cannot produce new
          // evidence; a 2nd consecutive read of an unchanged file that
          // returned nothing new cannot produce new text. Waiting for
          // the generic threshold (default 3) would burn another step in
          // both cases.
          const emit =
            sig.detector === "test_repeat"
              ? loopTracker.shouldEmitWarning(
                  sig.warningKey,
                  sig.count,
                  TEST_REPEAT_WARNING_THRESHOLD,
                )
              : sig.detector === "read_repeat"
                ? loopTracker.shouldEmitWarning(
                    sig.warningKey,
                    sig.count,
                    READ_REPEAT_WARNING_THRESHOLD,
                  )
                : loopTracker.shouldEmitWarning(sig.warningKey, sig.count);
          if (!emit) {
            continue;
          }
          pendingNotice =
            sig.detector === "wandering"
              ? formatWanderingRedirect(sig.tool, sig.count)
              : sig.detector === "test_repeat"
                ? formatTestRepeatNotice(sig)
                : sig.detector === "read_repeat" && sig.read !== undefined
                  ? formatReadRepeatNotice({ count: sig.count, ...sig.read })
                  : formatRepeatNotice(sig);
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: sig.tool,
            count: sig.count,
            stepIndex: i,
            level: "warn",
            detector: sig.detector,
            ...(sig.read !== undefined
              ? {
                  read: {
                    path: sig.read.path,
                    startLine: sig.read.startLine,
                    endLine: sig.read.endLine,
                    previousFingerprint: sig.read.previousFingerprint,
                    fingerprint: sig.read.fingerprint,
                  },
                }
              : {}),
          });
          this.deps.logger?.warn("no-progress loop detected", {
            sessionId: state.id,
            stepIndex: i,
            tool: sig.tool,
            count: sig.count,
            detector: sig.detector,
            // Path, range and fingerprints only — enough to reconstruct
            // WHY the detector fired without putting a line of the file
            // into the log.
            ...(sig.read !== undefined
              ? {
                  path: sig.read.path,
                  range: `${sig.read.startLine}-${sig.read.endLine}`,
                  fingerprint: sig.read.fingerprint,
                  previousFingerprint: sig.read.previousFingerprint,
                }
              : {}),
          });
        }
        state = await refreshMemoryContext(this.deps, state, options);
        recordSurfacedLessons(state);
        recordSurfacedProcedures(state);
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err));
        let category = classifyFailure(err);
        // `cancelled` is user-initiated and should close the turn
        // cleanly without marking the session as failed. Classified
        // BEFORE the finalization guard below: a user abort during the
        // reserved final step must keep its `cancelled` outcome
        // (issue #107 — cancellation semantics remain unchanged), not
        // be relabelled `max_steps`.
        const cancelled =
          err instanceof CancelledError ||
          (err instanceof LlmFailure && err.category === "cancelled") ||
          category === "cancelled";
        // The reply was cut short. Retry the step with a request the wall
        // does not apply to — a larger cap, or a prompt packed to the
        // window the server just revealed. Same replay argument as the
        // outage wait below: the completion failed before any tool ran.
        // Ahead of the finalization guard on purpose: the summary step
        // is the one a reasoning model is likeliest to think past, and
        // one bounded retry that replays nothing is not "more work".
        const truncationPlan: TruncationRetryPlan | null = cancelled
          ? null
          : planTruncationRetry({
              error: err,
              alreadyRetried: truncationRetry?.stepIndex === i,
              contextWindow: this.deps.contextWindow?.() ?? null,
              fallbackMaxTokens: getConfig().localModels.completionMaxTokens,
              canFitWindow: this.deps.onContextWindowObserved !== undefined,
            });
        if (truncationPlan !== null) {
          const detail: TruncationDetail = truncationPlan.detail;
          const retry: TruncationRetry = truncationPlan.retry;
          truncationRetry = {
            stepIndex: i,
            original: runError,
            ...(retry.kind === "raise_cap"
              ? { maxTokens: retry.maxTokens }
              : {}),
          };
          if (retry.kind === "fit_window") {
            this.deps.onContextWindowObserved?.(retry.contextWindow);
          }
          // A cut reply is still tokens on the wire, so — like the
          // parse failure below — it breaks any run of empty
          // completions. (A provider outage does not: it produces no
          // completion at all, so the empties on either side of it are
          // still consecutive completions.)
          emptyRecoveries = 0;
          // The notice the cut attempt carried (loop detector, steering,
          // a trimmed batch) is still owed to the retry.
          pendingNotice = composeTruncationNotice(
            noticeForThisStep,
            detail,
            retry,
          );
          this.deps.onEvent?.({
            type: "completion_truncated",
            stepIndex: i,
            cause: detail.cause,
            completionTokens: detail.completionTokens,
            promptTokens: detail.promptTokens,
            requestedMaxTokens: detail.requestedMaxTokens,
            retry,
          });
          this.deps.logger?.warn("completion truncated; retrying the step", {
            sessionId: state.id,
            stepIndex: i,
            cause: detail.cause,
            completionTokens: detail.completionTokens,
            promptTokens: detail.promptTokens,
            requestedMaxTokens: detail.requestedMaxTokens,
            retry: retry.kind,
            ...(retry.kind === "raise_cap"
              ? { maxTokens: retry.maxTokens }
              : { contextWindow: retry.contextWindow }),
          });
          runError = null;
          i -= 1;
          continue;
        }
        // The retry this turn ANNOUNCED, landing on the finalization
        // step and coming back empty again.
        //
        // The guard below normally swallows a finalization failure: the
        // turn ends `max_steps`/`stalled` and `runError` is dropped.
        // That is right for a step nobody was promised, and wrong here.
        // The operator was told the turn was trying again, and without
        // this recovery the same scenario ends `failed` carrying the
        // model's own diagnosis — so swallowing it would trade a
        // readable failure for "ran out of steps" AND drop the error
        // report, since only `loop_failed` is captured. Reporting it
        // executes no further work, which is the one thing the
        // finalization guard exists to prevent.
        //
        // Both ceilings put the retry here: the step ceiling whenever
        // the empty lands on the second-to-last allowed step (`run
        // --max-steps 2`; a fusion worker at step 38 of its 40), and
        // the duration ceiling whenever `agent.task.maxDurationMs` is
        // crossed between the two attempts.
        const repeatedEmptyAfterAnnouncedRetry =
          emptyRecoveries > 0 && isRecoverableEmptyCompletion(err);
        if (
          finalizationStep &&
          !cancelled &&
          !repeatedEmptyAfterAnnouncedRetry
        ) {
          // A failed finalization must not execute more work or turn a
          // bounded run into an unbounded retry. Preserve the established
          // explicit max-steps/stalled outcome instead.
          this.deps.logger?.warn(
            "finalization step failed; preserving max-steps outcome",
            {
              sessionId: state.id,
              stepIndex: i,
              error: runError.message,
              category,
            },
          );
          stepsTaken += 1;
          reason = "max_steps";
          break;
        }
        // The completion came back but could not be read as tool calls,
        // and the step executor's in-step repair did not rescue it
        // either. Spend an ordinary step on it rather than ending the
        // turn: the next prompt is built fresh at the full completion
        // budget — which the capped repair is not — and carries a
        // `### notice` naming what was rejected, so the model has
        // something to correct against. Same replay argument as the
        // outage park below: a parse failure throws before any tool is
        // dispatched, so nothing is repeated and no side effect is
        // duplicated.
        //
        // The step is counted. It consumed an inference, and leaving
        // `legMadeProgress` false means a leg made entirely of rejected
        // completions still stops at the boundary as `no_progress`.
        //
        // `recoveryStepAvailable` is the leg-boundary half of the
        // finalization guard above: a recovery on the last step of a
        // barren leg would announce a retry the `no_progress` break
        // never performs.
        if (
          !cancelled &&
          parseRecoveries < PARSE_RECOVERY_BUDGET &&
          recoveryStepAvailable(i) &&
          isRecoverableParseFailure(err)
        ) {
          parseRecoveries += 1;
          stepsTaken += 1;
          // The model emitted tokens, just not readable ones — so this
          // breaks any run of empty completions.
          emptyRecoveries = 0;
          // The notice this step was carrying (loop detector, steering,
          // a trimmed batch) is still owed to the next one.
          pendingNotice = composeParseFailureNotice(
            noticeForThisStep,
            runError.message,
          );
          this.deps.onEvent?.({
            type: "parse_failure_recovered",
            stepIndex: i,
            attempt: parseRecoveries,
            budget: PARSE_RECOVERY_BUDGET,
            reason: runError.message,
          });
          this.deps.logger?.warn(
            "completion could not be parsed; retrying the turn",
            {
              sessionId: state.id,
              stepIndex: i,
              attempt: parseRecoveries,
              budget: PARSE_RECOVERY_BUDGET,
              error: runError.message,
              category,
            },
          );
          runError = null;
          continue;
        }
        // The completion came back with nothing in it at all — no
        // content, no reasoning, no tool calls — so there was nothing
        // for the parser to read and nothing for the in-step repair to
        // fix. Spend an ordinary step on it for the same reason as the
        // parse failure above: the inference threw before any tool was
        // dispatched, so nothing is repeated, and the next prompt
        // carries a `### notice` telling the model its reply was empty,
        // which is the only correction available for this shape.
        //
        // The step is counted, as the parse recovery is: it consumed an
        // inference, and a leg made of empty completions must still
        // reach its boundary as `no_progress`.
        //
        // And it is only taken when a step is actually left to spend:
        // on the last step of a barren leg the retry would be announced
        // and never performed, and the operator would be handed
        // "ran out of steps" in place of the model's own diagnosis.
        //
        // `!finalizationStep` is redundant today — the guard above only
        // falls through to here for a repeated empty, which has already
        // spent the budget — but it is the invariant that keeps it
        // redundant: a budget above one must never announce a retry on
        // a step the loop is about to leave.
        if (
          !cancelled &&
          !finalizationStep &&
          emptyRecoveries < EMPTY_COMPLETION_RECOVERY_BUDGET &&
          recoveryStepAvailable(i) &&
          isRecoverableEmptyCompletion(err)
        ) {
          emptyRecoveries += 1;
          stepsTaken += 1;
          pendingNotice = composeEmptyCompletionNotice(noticeForThisStep);
          this.deps.onEvent?.({
            type: "empty_completion_recovered",
            stepIndex: i,
            attempt: emptyRecoveries,
            budget: EMPTY_COMPLETION_RECOVERY_BUDGET,
          });
          this.deps.logger?.warn("completion was empty; retrying the turn", {
            sessionId: state.id,
            stepIndex: i,
            attempt: emptyRecoveries,
            budget: EMPTY_COMPLETION_RECOVERY_BUDGET,
            category,
          });
          runError = null;
          continue;
        }
        // The budget is spent and the model returned nothing again. The
        // turn is terminal now, but `detectModelFailure`'s message
        // describes a single empty completion — an operator reading it
        // would reasonably conclude the runtime never retried. Say the
        // count instead.
        // `category` is deliberately not recomputed: the rewrite keeps
        // the same `reason` on a `ModelError`, whose category is pinned
        // to `model`, so reclassifying could only ever return what it
        // already holds.
        if (repeatedEmptyAfterAnnouncedRetry) {
          runError = repeatedEmptyCompletionError(err);
        }
        // The provider is not answering. Park the turn instead of
        // killing it: nothing of this step has been committed (a
        // completion failure throws before any tool is dispatched —
        // tool failures come back as results, not throws), so retrying
        // the same index replays nothing and duplicates no side effect.
        if (
          category === "transport" &&
          !cancelled &&
          providerWaitCfg.enabled &&
          isWaitableOutage(err) &&
          outageWaitedMs < providerWaitCfg.maxWaitMs
        ) {
          const nextRetryMs = Math.min(
            PROVIDER_WAIT_MAX_BACKOFF_MS,
            PROVIDER_WAIT_BASE_MS * 2 ** outageAttempts,
            // Never sleep past the budget: the last wait ends exactly at
            // it, so the operator's configured ceiling is the truth.
            Math.max(1, providerWaitCfg.maxWaitMs - outageWaitedMs),
          );
          outageAttempts += 1;
          awaitingRecovery = true;
          this.deps.onEvent?.({
            type: "provider_waiting",
            attempt: outageAttempts,
            waitedMs: outageWaitedMs,
            maxWaitMs: providerWaitCfg.maxWaitMs,
            nextRetryMs,
            reason: runError.message,
          });
          this.deps.logger?.warn("provider unreachable; parking the turn", {
            sessionId: state.id,
            stepIndex: i,
            attempt: outageAttempts,
            waitedMs: outageWaitedMs,
            nextRetryMs,
            error: runError.message,
          });
          await abortableSleep(nextRetryMs, options.signal);
          outageWaitedMs += nextRetryMs;
          runError = null;
          // The retried step still owes the model the notice this
          // attempt carried.
          pendingNotice = noticeForThisStep;
          if (options.signal.aborted) {
            reason = "cancelled";
            state = { ...state, status: "cancelled" };
            this.deps.onEvent?.({
              type: "loop_completed",
              reason: "cancelled",
            });
            state = incrementTurnCount(state);
            break;
          }
          // Retry the very same step index: `i += 1` runs on `continue`,
          // so step back one to land on it again.
          i -= 1;
          continue;
        }
        // A raised cap the provider refused — a 400 naming `max_tokens`
        // or the context length — is not a new failure. The turn fails
        // with the truncation that started it, which names the knob.
        if (
          truncationRetry?.stepIndex === i &&
          truncationRetry.maxTokens !== undefined &&
          isRequestSizeRejection(err)
        ) {
          this.deps.logger?.warn(
            "provider refused the raised reply cap; failing with the truncation",
            {
              sessionId: state.id,
              stepIndex: i,
              maxTokens: truncationRetry.maxTokens,
              rejection: runError.message,
            },
          );
          runError = truncationRetry.original;
          category = classifyFailure(runError);
        }
        this.deps.logger?.error("agent loop failed", {
          sessionId: state.id,
          stepIndex: i,
          error: runError.message,
          category,
        });
        this.deps.onEvent?.({
          type: "loop_failed",
          error: runError,
          category,
        });
        this.deps.metrics?.recordLlmFailure({
          sessionId: state.id,
          category,
        });
        if (cancelled) {
          state = { ...state, status: "cancelled" };
          this.deps.onEvent?.({ type: "loop_completed", reason: "cancelled" });
          state = incrementTurnCount(state);
          const durationMs = Date.now() - turnStartedAt;
          this.deps.onEvent?.({
            type: "turn_finished",
            turnIndex,
            reason: "cancelled",
            stepCount: stepsTaken,
            durationMs,
          });
          return {
            session: state,
            reason: "cancelled",
            stepCount: stepsTaken,
            undelivered: this.flushSteering(state.id),
          };
        }
        // Symmetric with the cancelled path above: set terminal state,
        // emit `loop_completed` + `turn_finished`, increment turnCount,
        // and RETURN — never throw. Callers (CLI / TUI / task-runner /
        // OpenAI HTTP / Telegram) all already key off
        // `result.session.status === "failed"` or `result.reason ===
        // "failed"`; the throw was an unintended asymmetry that
        // pre-dated the `failed` branch in `task-runner.ts:288-294` and
        // `tui/chat-orchestrator.ts:293`. Throwing here also caused the
        // outer CLI catch to drop the JSON status block, hiding
        // sessionId from the eval harness — the very symptom we are
        // fixing here. `cancelled` and `failed` are both classified
        // terminations; only programming bugs or unclassified errors
        // should ever bubble past this point.
        //
        // Leave the failure in the transcript. Without it the next turn
        // — usually the operator typing "try again" — is built from a
        // history in which the attempt never happened, and the model
        // reproduces the same rejected output. Recorded only: every
        // surface already renders its own line from `loop_failed`, so
        // emitting an `assistant_reply` event here would post the text
        // twice.
        state = recordTurn(
          state,
          assistantReplyTurn(
            formatTurnFailedRecord(category, runError.message),
          ),
        );
        state = { ...state, status: "failed", lastError: runError.message };
        this.deps.onEvent?.({ type: "loop_completed", reason: "failed" });
        state = incrementTurnCount(state);
        const durationMs = Date.now() - turnStartedAt;
        this.deps.onEvent?.({
          type: "turn_finished",
          turnIndex,
          reason: "failed",
          stepCount: stepsTaken,
          durationMs,
        });
        // Phase 6 — bump failure_count for every surfaced lesson.
        // `cancelled` is intentionally NOT routed here; that branch
        // returned earlier without calling the hook (cancellation
        // carries neither success nor failure signal).
        if (!options.ephemeral) {
          invokeLessonLifecycle(
            this.deps,
            state.id,
            surfacedLessonIds,
            "failure",
          );
        }
        return {
          session: state,
          reason: "failed",
          stepCount: stepsTaken,
          undelivered: this.flushSteering(state.id),
        };
      }
    }

    if (reason === "cancelled") {
      state = { ...state, status: "cancelled" };
      this.deps.onEvent?.({ type: "loop_completed", reason });
    } else if (reason === "max_steps") {
      const synthetic = formatTaskStoppedReply({
        cause: stopCause,
        stepsTaken,
        stepCeiling,
        elapsedMs: Date.now() - taskStartedAt,
      });
      state = recordTurn(state, assistantReplyTurn(synthetic));
      this.deps.onEvent?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: synthetic },
      });
      this.deps.onEvent?.({ type: "loop_completed", reason });
      if (state.status !== "completed") {
        // `stalled` (not `pending`) signals to operators that the turn
        // hit the step budget without a natural close. `lastError`
        // carries the machine-readable reason plus the observed step
        // count so post-mortem tooling does not need to replay events.
        state = {
          ...state,
          status: "stalled",
          lastError: `task_stopped:${stopCause}: ${stepsTaken} steps without reply`,
        };
      }
    } else if (reason === "reply") {
      state = { ...state, status: "pending" };
      this.deps.onEvent?.({ type: "loop_completed", reason });
    } else if (reason === "finish") {
      this.deps.logger?.info("agent loop finished via finish tool", {
        sessionId: state.id,
      });
      this.deps.onEvent?.({ type: "loop_completed", reason });
    }

    state = incrementTurnCount(state);
    const durationMs = Date.now() - turnStartedAt;
    this.deps.onEvent?.({
      type: "turn_finished",
      turnIndex,
      reason,
      stepCount: stepsTaken,
      durationMs,
    });

    // Phase 6 — bump success/failure counters on surfaced lessons.
    // `reply` / `finish` are positive outcomes; `cancelled` /
    // `max_steps` are filtered out (neither a success nor failure
    // signal). The `failed` branch already fired the hook above
    // before its early `return`.
    if (!options.ephemeral && (reason === "reply" || reason === "finish")) {
      invokeLessonLifecycle(this.deps, state.id, surfacedLessonIds, "success");
    }

    // Fire async memory reflection. Never awaited — the runner
    // swallows its own errors; the loop stays decoupled from
    // memory-formation latency.
    //
    // Legacy (segmentation disabled): fire on `reason === "reply"`
    // when a user message arrived this turn, using a single
    // user/assistant pair.
    //
    // Segmentation enabled (v2.5 Phase B):
    //   - On `reply`: fire iff `state.turnCount % triggerEveryTurns
    //     === 0` (cadence gate).
    //   - On `finish`: fire unconditionally — final flush so the
    //     trailing partial window is never lost.
    //   - Pack the last `windowTurns` user/assistant pairs into
    //     `ReflectionInput.transcript`. The trailing pair's content
    //     is also mirrored into `userMessage`/`assistantReply` so
    //     the runner contract stays satisfied.
    //
    // Never for an ephemeral turn: a fusion worker's transcript is the
    // orchestrator's scratch space, and reflecting on it would write
    // half-context into the operator's long-term memory.
    if (
      this.deps.reflectionRunner &&
      !options.ephemeral &&
      (reason === "reply" || reason === "finish")
    ) {
      const segmentation = this.deps.reflectionSegmentation;
      const segmentationActive =
        segmentation?.enabled === true &&
        segmentation.triggerEveryTurns >= 1 &&
        segmentation.windowTurns >= 1;
      const shouldFire = segmentationActive
        ? reason === "finish" ||
          (reason === "reply" &&
            state.turnCount > 0 &&
            state.turnCount % segmentation!.triggerEveryTurns === 0)
        : reason === "reply" && options.userMessage !== undefined;
      if (shouldFire) {
        const transcript = segmentationActive
          ? collectLastUserAssistantPairs(state, segmentation!.windowTurns)
          : [];
        const trailingPair =
          transcript.length > 0 ? transcript[transcript.length - 1] : null;
        const userMessage = segmentationActive
          ? (trailingPair?.user ?? options.userMessage ?? null)
          : (options.userMessage ?? null);
        const assistantReply = segmentationActive
          ? (trailingPair?.assistant ?? findLastAssistantReply(state))
          : findLastAssistantReply(state);
        // Skip when we genuinely have nothing to extract from
        // (e.g. a `finish`-only session without a user/assistant
        // pair). The runner contract requires non-null
        // `userMessage` / `assistantReply`.
        if (userMessage !== null && assistantReply !== null) {
          // Memory-v2 phase 7a. The allowlist for the vote-runner
          // is the union of (notes recalled this turn) ∪ (lessons
          // recalled across all steps of this turn) ∪ (profile
          // facts currently active). Profile facts are not gated
          // by recall — they're always candidates because the
          // renderer surfaces them whenever they are pinned or pass
          // the contextual-keyword gate. Sourcing them here keeps the
          // decorator's hydration cheap.
          // `profileFactsProvider` is a raw `profileStore.list()`.
          // It is only ever an input to the fire-and-forget reflection
          // below, so a store failure here must not fail the turn the
          // user is waiting on — an empty allowlist just means the
          // vote-runner sees no profile candidates this turn.
          let profileFacts: readonly ProfileFact[] = [];
          try {
            profileFacts = this.deps.profileFactsProvider?.() ?? [];
          } catch (err) {
            // Usually the step guard above has already warned for this
            // turn — same provider, same store. Not always: the store
            // can close between the last step and this block.
            this.deps.logger?.warn("profile facts unavailable for reflection", {
              sessionId: state.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // `reflect()` is documented fire-safe, but it is composed at
          // runtime from decorators that read SQLite stores. A bare
          // `void` turns any escape into an unhandled rejection the
          // loop can neither see nor recover from, so the trailing
          // `.catch` pins the contract at the call site too.
          void this.deps.reflectionRunner
            .reflect({
              sessionId: state.id,
              userMessage,
              assistantReply,
              // Memory-v2 phase 2. Surfaced ids for this turn — the
              // allowlist for the link-generator sub-call. Empty /
              // undefined when memory.notes is disabled OR no recall
              // was performed.
              ...(state.recalledNotes && state.recalledNotes.length > 0
                ? { recalledMemoryIds: state.recalledNotes.map((n) => n.id) }
                : {}),
              // Memory-v2 phase 7a. Allowlist for the vote-runner —
              // every lesson surfaced through any step of this turn,
              // every profile fact currently active.
              ...(surfacedLessonIds.size > 0
                ? { recalledLessonIds: Array.from(surfacedLessonIds) }
                : {}),
              ...(surfacedProcedureIds.size > 0
                ? { recalledProcedureIds: Array.from(surfacedProcedureIds) }
                : {}),
              ...(profileFacts.length > 0
                ? {
                    recalledProfileFactIds: profileFacts
                      .map((f) => f.id)
                      .filter((id): id is number => typeof id === "number"),
                  }
                : {}),
              turnIndex: state.turns.length,
              // v2.5 (Phase B). Multi-turn window
              // is only attached when segmentation is active —
              // otherwise the runner falls back to the byte-stable
              // single-pair prompt.
              ...(segmentationActive && transcript.length > 0
                ? { transcript }
                : {}),
            })
            .catch((err: unknown) => {
              this.deps.logger?.warn("reflection failed after dispatch", {
                sessionId: state.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }
    }

    return {
      session: state,
      reason,
      stepCount: stepsTaken,
      undelivered: this.flushSteering(state.id),
    };
  }

  /**
   * Close the steering window and empty the inbox on the way out of a
   * turn — one indivisible step, which is the whole point.
   *
   * A message pushed after the loop's last drain — during the final
   * inference, or at any point in a turn that was cancelled before it
   * stepped — would otherwise sit in the inbox until some unrelated
   * later turn happened to pick it up, out of order and out of context.
   * What is already pending is handed back to the caller as
   * `undelivered`; what arrives from here on is refused at `push`, so
   * the sender learns immediately that it was not steered. Together
   * that keeps "the message you sent always goes somewhere" true on
   * every exit path, with no window in between.
   */
  private flushSteering(sessionId: string): readonly string[] {
    return this.deps.steeringInbox?.closeAndDrain(sessionId) ?? [];
  }
}

/**
 * Phase 6 — fire the lesson lifecycle hook exactly once with the
 * de-duplicated set of surfaced ids. Empty set or missing hook is a
 * silent no-op. Hook errors are swallowed so a sqlite hiccup never
 * derails the agent-loop return path.
 */
function invokeLessonLifecycle(
  deps: AgentLoopDependencies,
  sessionId: string,
  surfacedIds: ReadonlySet<number>,
  outcome: LessonLifecycleOutcome,
): void {
  const hook = deps.lessonLifecycle;
  if (!hook) return;
  if (surfacedIds.size === 0) return;
  try {
    hook.recordTurnOutcome({
      sessionId,
      surfacedLessonIds: Array.from(surfacedIds),
      outcome,
    });
  } catch (err) {
    deps.logger?.warn?.("lesson lifecycle hook failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function findLastAssistantReply(state: SessionState): string | null {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const turn = state.turns[i];
    if (turn?.kind === "assistant_reply") return turn.text;
  }
  return null;
}

async function refreshMemoryContext(
  deps: AgentLoopDependencies,
  state: SessionState,
  options: RunTurnOptions,
): Promise<SessionState> {
  if (!deps.memoryContextProvider) return state;
  // An ephemeral (fusion worker) turn neither reads nor primes memory:
  // its prompt is the orchestrator's instruction, not the operator's
  // history, and the recall would only pull unrelated notes into it.
  if (options.ephemeral) return state;
  try {
    const ctx = await deps.memoryContextProvider.buildMemoryContext({
      sessionId: state.id,
      userMessage: options.userMessage ?? null,
      toolResultSummaries: collectRecentToolResultSummaries(state),
      // v2.5 (Phase A). Project the session's
      // existing `user`/`assistant_reply` turns into the shape the
      // rewriter decorator expects. The current user message lives
      // in `userMessage` above, so we exclude it from this list to
      // keep semantics clean: `recentTurns` is "history BEFORE this
      // turn's user message". The agent loop has already appended
      // the current user turn to `state.turns` at this point, so we
      // drop the trailing user row whose `text` matches.
      recentTurns: collectRecentUserAssistantTurns(state, options.userMessage),
      signal: options.signal,
    });
    const lessons = ctx.lessons ?? [];
    if (lessons.length > 0) {
      deps.metrics?.recordLessonsRecalled({
        sessionId: state.id,
        hits: lessons.length,
      });
    }
    const procedures = ctx.procedures ?? [];
    if (procedures.length > 0) {
      deps.metrics?.recordProceduresRecalled({
        sessionId: state.id,
        hits: procedures.length,
      });
    }
    return {
      ...state,
      recalledNotes: ctx.recalled,
      memoryIndex: ctx.index,
      recalledLessons: lessons,
      recalledProcedures: procedures,
    };
  } catch (err) {
    deps.logger?.warn("memory context provider failed", {
      sessionId: state.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return state;
  }
}

function collectRecentToolResultSummaries(
  state: SessionState,
  maxEntries = 4,
): string[] {
  const summaries: string[] = [];
  for (
    let i = state.turns.length - 1;
    i >= 0 && summaries.length < maxEntries;
    i -= 1
  ) {
    const turn = state.turns[i];
    if (turn?.kind !== "tool_result") continue;
    summaries.push(`${turn.tool}: ${turn.summary}`);
  }
  return summaries.reverse();
}

/**
 * v2.5 (Phase A). Walk the session backwards and
 * collect the trailing `user` / `assistant_reply` rows in
 * chronological order. Excludes the just-arrived user message
 * (matched against `currentUserMessage`) so the rewriter's history
 * never contains the message it is being asked to rewrite. The cap
 * is intentionally generous so a long-context decorator (e.g. a
 * future segmentation-aware rewriter) can use a wider window without
 * a second pass.
 */
const RECENT_TURN_PROJECTION_CAP = 12;

/**
 * v2.5 (Phase B). Walk the session backwards and
 * collect the trailing user/assistant pairs in chronological order
 * for the segmentation-aware reflection window. A "pair" is a `user`
 * row followed by the next `assistant_reply` row in the conversation.
 * Intervening tool calls / results are ignored — the reflection
 * prompt only consumes the human/agent text.
 *
 * Returns up to `windowTurns` pairs in chronological order (oldest
 * first). When the trailing turn has a `user` row without an
 * `assistant_reply` (e.g. the model emitted `finish` before
 * replying), that orphan pair is dropped so every entry in the
 * window is complete.
 */
function collectLastUserAssistantPairs(
  state: SessionState,
  windowTurns: number,
): { user: string; assistant: string }[] {
  if (windowTurns <= 0) return [];
  // Walk forward to produce stable pair boundaries: each `user` row
  // owns the *next* `assistant_reply` row that follows it (if any).
  const pairs: { user: string; assistant: string }[] = [];
  let pendingUser: string | null = null;
  for (const turn of state.turns) {
    if (!turn) continue;
    if (turn.kind === "user") {
      // Consecutive user rows exist since mid-turn steering: the steer
      // must not REPLACE the founding message in the reflection pair —
      // memory extraction would then attribute the whole turn to the
      // correction alone. Join them in order instead.
      pendingUser =
        pendingUser === null ? turn.text : `${pendingUser}\n\n${turn.text}`;
    } else if (turn.kind === "assistant_reply" && pendingUser !== null) {
      pairs.push({ user: pendingUser, assistant: turn.text });
      pendingUser = null;
    }
  }
  if (pairs.length <= windowTurns) return pairs;
  return pairs.slice(pairs.length - windowTurns);
}

function collectRecentUserAssistantTurns(
  state: SessionState,
  currentUserMessage: string | undefined,
): { role: "user" | "assistant"; text: string }[] {
  const rows: { role: "user" | "assistant"; text: string }[] = [];
  for (
    let i = state.turns.length - 1;
    i >= 0 && rows.length < RECENT_TURN_PROJECTION_CAP;
    i -= 1
  ) {
    const turn = state.turns[i];
    if (!turn) continue;
    if (turn.kind === "user") {
      // Skip the trailing user row that mirrors `currentUserMessage`
      // — the rewriter consumes that via `MemoryContextProviderInput.userMessage`.
      if (
        rows.length === 0 &&
        currentUserMessage !== undefined &&
        turn.text === currentUserMessage
      ) {
        continue;
      }
      rows.push({ role: "user", text: turn.text });
    } else if (turn.kind === "assistant_reply") {
      rows.push({ role: "assistant", text: turn.text });
    }
  }
  return rows.reverse();
}
