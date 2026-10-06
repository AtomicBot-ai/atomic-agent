import type { ToolRole } from "../tools/tool-roles.js";
import type { CompletionResult, StreamChunk } from "../llm/llama-server-client.js";
import type { SlotManager } from "../llm/slot-manager.js";
import type { ReasoningEffort, ToolCallTransport } from "../llm/provider/completion-types.js";
import type { ToolCallAdapter } from "../llm/provider/adapters/tool-call-adapter.js";
import type { ModelProfile } from "../llm/model-profile.js";
import type { ModelProfileManager } from "../llm/model-profile-manager.js";
import type { LocalBackendGate } from "../llm/local-backend-gate.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ProviderWaitCause, ProviderWaitFailure } from "../llm/reliability/provider-wait-cause.js";
import type { LlmFailureCategory, TruncationCause } from "../llm/index.js";
import type { SessionState } from "../session/session-state.js";
import type { CapabilitiesSummary, SkillCatalogEntry, ToolDescriptor } from "../prompt/stable-prefix.js";
import type { MemoryEntry, MemoryIndexEntry } from "../memory/memory-store.js";
import type { LessonIndexEntry } from "../memory/lessons/lesson-store.js";
import type { ProcedureIndexEntry } from "../memory/procedures/procedure-store.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { ReflectionRunner } from "../memory/reflection/index.js";
import type { MemoryHealthWarning } from "../memory/health/index.js";
import type { LlmStreamParams, StepApprovalPostureSource } from "./step/step-contract.js";
import type { StepEvent } from "./step-events.js";
import type { TruncationRetry } from "./turn/truncation-recovery.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { ProfileClippedEvent } from "./profile-clip-warning.js";
import type { ReviewStallSignal } from "./review-stall.js";

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
   * The live approval gate, read by the step when a batch of
   * approval-gated calls arrives: if nothing in it would ask a human
   * (e.g. `--no-approval`), the batch runs in emitted order instead of
   * being trimmed to its first call. Absent (embedders, tests) keeps the
   * trim.
   */
  approvalPosture?: StepApprovalPostureSource;
  /**
   * Whether the run mode resolves to fusion right now. Read per turn,
   * for the reason `isPlanMode` is read per call: the operator can flip
   * the mode between turns and the next turn should honour it. Absent
   * (embedders, tests) means "not fusion", which gates nothing.
   */
  isFusionMode?: () => boolean;
  /**
   * Drop the fan-out approval a previous turn on this session earned.
   * See `approval/fanout-scope.ts`: the answer is scoped to one job.
   */
  clearFanoutTurnGrant?: (sessionId: string) => void;
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
   * The local worker leg's request-slot count as the server reported it
   * (`SlotManager.observedPoolSize`), `null` until a `/props` answer has
   * sized the pool. Read per step; it reaches the `### fusion` machine
   * facts for an external llama-server whose `--parallel` the config
   * cannot state. Moves once — when the pool is first observed — and the
   * prefix moves with it, the same cost as a config write.
   */
  liveWorkerSlots?: () => number | null;
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
   * Whether the active model declares `supportsTools: "strict"`, so the
   * native-tools request should constrain the decode to the tool
   * schemas. Defaults to `false`: the level is opt-in per model and
   * every tool the adapter cannot express strictly ships unchanged.
   */
  strictTools?: boolean;
  /**
   * Resolve the wire slice for a provider a turn is pinned to
   * (`RunTurnOptions.providerId`). The global fields above describe
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
   * Installed skills `skills.catalogTokenBudget` left out of
   * `skillCatalog`, rebuilt alongside it. Renders the `### skills`
   * truncation marker (issue #466).
   */
  skillCatalogDropped?: number;
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
   * in README.md. Absent in tests and in surfaces that do not offer
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
 * The per-link wire shape a pinned turn is built for — the same facts
 * `AgentLoopDependencies` carries for the active provider, resolved
 * for the pinned one instead. See `AgentLoopDependencies.resolveLlmSlice`.
 */
export interface ResolvedTurnLlmSlice {
  toolTransport: ToolCallTransport;
  toolCallAdapter: ToolCallAdapter | null;
  supportsSlotAffinity: boolean;
  supportsParallelTools: boolean;
  strictTools: boolean;
  /**
   * Whether the pinned link is the local `llama-server` — i.e. whether
   * the `/props` profile in hand describes the model that will serve
   * this turn. Only the pin can answer it: `localBackend.isActive()`
   * describes the ACTIVE provider, which on a pinned Fusion worker turn
   * is the orchestrator's cloud leg. Optional so legacy / test wiring
   * that predates it still type-checks; absent falls back to the active
   * provider's answer, which is what every single-leg run already did.
   */
  isLlamaServer?: boolean;
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
 * Why a task stopped without the model closing it. The three ceilings
 * are the loop's own; `credit_exhausted` is the provider's — the account
 * cannot pay for the next request, so the turn parks where it is and
 * resumes after a top-up, the same way as after a ceiling.
 */
export type TaskStopCause =
  "step_ceiling" | "time_ceiling" | "no_progress" | "credit_exhausted";

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
   * The operator's request behind this turn, as the runtime records it
   * for the workers' briefs (`pickOriginalRequest`). Reaches every step's
   * prompt as `### request` once the packer has dropped the user turn
   * that carried it, so a repair turn still sees the spec. Absent in
   * test / legacy wiring, where nothing is pinned.
   */
  originalRequest?: string;
  /**
   * The serving route changed since this session's previous turn: the
   * runtime's note saying so (`prompt/route-change-note.ts`). Reaches
   * every step of this turn as `### route`; the runtime computes it
   * once per change, so the next turn carries none.
   */
  routeNote?: string;
  /**
   * Reasoning effort for every completion of this turn, mapped per
   * provider family by the body builder. A fusion worker's
   * `workerReasoning`; absent, the provider's default.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Output ceiling for every completion of this turn, below the
   * provider's own. A fusion worker's `workerMaxOutputTokens`; the
   * truncation retry's per-step cap still wins over it.
   */
  maxOutputTokens?: number;
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
  /**
   * The turn's tool role (`src/tools/tool-roles.ts`): which tools the
   * prompt describes in full, the native wire carries and the local
   * grammar admits without a `tool.view` first. A fusion worker passes
   * `builder`. Absent, an orchestrator turn in fusion mode is
   * `orchestrator` and every other turn is `full` — the whole catalog,
   * byte-identical to before roles existed.
   */
  toolRole?: ToolRole;
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
      /**
       * What the failure was, from the error itself rather than its
       * message — the part a UI may word. `reason` stays the raw line
       * for logs and traces.
       */
      cause?: ProviderWaitCause;
      /**
       * The errno-like code the transport left on the failure's `cause`
       * chain (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`,
       * `UND_ERR_SOCKET`, …), as `readErrnoCode` reads it. `reason` is
       * often a bare `fetch failed`, which looks the same for a local
       * server that is not running (refused) and a network that is down
       * (unreachable, timed out); this is the fact that tells them apart
       * in a trace or a log. Absent when the transport left no code.
       */
      causeCode?: string;
      /**
       * The provider link the turn is waiting on: the one whose failure
       * parked it. With a fallback chain that is the last link tried,
       * often not the provider the user picked (a stopped local server
       * the chain appended after a cloud one). Absent when the failure
       * did not come through the chain or a pinned link.
       */
      providerId?: string;
      /**
       * The links that failed before the one waited on, in the order
       * they were tried, each with its own cause. The provider the user
       * picked is usually the first, and why it failed (an account out
       * of funds, a refused key) is the part a UI says before the link
       * it waits on (item 40). Absent when nothing failed before it.
       */
      fallbackFailures?: readonly ProviderWaitFailure[];
    }
  | {
      /** The provider answered again; the parked turn is running on. */
      type: "provider_recovered";
      waitedMs: number;
    }
  | {
      /**
       * The provider's error body says the account cannot pay
       * (`credit_balance_exhausted`, `insufficient_credits`, a 402
       * naming credit). The turn stops where it is, resumable after a
       * top-up — `loop_completed` follows with `max_steps` and the
       * session records `task_stopped:credit_exhausted`. `provider` is
       * the link that said so.
       */
      type: "credit_exhausted";
      provider: string;
      code: string;
      message: string;
    }
  | {
      /**
       * The provider refused the request for step `stepIndex` as too
       * large for its context window; the window was learned
       * (`source: "provider"` from the body's own number, `"estimate"`
       * from the prompt estimate) and the same step is being retried
       * with the conversation packed to it. Fired once per step; a
       * second refusal fails the turn with the provider's sentence.
       */
      type: "prompt_repacked";
      stepIndex: number;
      contextWindow: number;
      source: "provider" | "estimate";
      promptTokens: number;
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
      /** The cap the cut request carried; absent when it carried none. */
      requestedMaxTokens?: number;
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
      /**
       * `usage` is not a line: it carries a fresh `contextTokens` for the
       * live worker row and the feed renders nothing for it.
       */
      phase: "started" | "tool" | "usage" | "finished" | "failed" | "cancelled";
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
      /**
       * `phase: "usage"` only: how full this worker's context is, as its
       * last completion counted it — `timing.promptTokens`, the figure
       * the composer's context chip takes from `llm_completed` (llama.cpp
       * `prompt_n + tokens_cached`, so a warm KV cache is not
       * under-counted). Measured, never estimated.
       */
      contextTokens?: number;
      /** `phase: "tool"` only: the tool this leg just started. */
      tool?: string;
      /**
       * The orchestrator's estimate for this task, in seconds, when it
       * gave one (`tasks[].etaSeconds`). Advisory: the live readout
       * puts it beside the elapsed time so "42s" can be read as fast or
       * slow. Nothing is scheduled or timed out against it.
       */
      etaSeconds?: number;
      stepCount?: number;
      durationMs?: number;
      /** One line about the outcome; the worker's reply, clipped. */
      summary?: string;
    }
  /** `### profile` was clipped at `memory.profile.maxTokens` (issue #407). */
  | ProfileClippedEvent
  | { type: "step_started"; stepIndex: number }
  | {
      type: "step_finished";
      stepIndex: number;
      summary: string;
      durationMs: number;
      /**
       * The step kept a `reply` batched with work tools as a progress
       * note and the turn went on (`progress-note-reply.ts`).
       */
      progressNote?: true;
      /**
       * The step ran under a stalled Fusion review (`review-stall.ts`):
       * `steps` read-only steps had passed without a fan-out, and the
       * step carried the notice (`notice`) or admitted only
       * `fusion.delegate` / `reply` / `finish` (`cut`).
       */
      reviewStall?: ReviewStallSignal;
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
        | "read_repeat"
        | "outcome_repeat";
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
   * per state transition (never on sticky turns). See ../llm/docs/fallback.md.
   */
  | {
      type: "provider_switched";
      direction: "away" | "back";
      from: string;
      to: string;
      reason: string;
    }
  /**
   * A memory sub-call (reflection, link generation, voting, query
   * rewriting) timed out or failed several times in a row for this
   * session. Emitted by the runtime, not the loop — those sub-calls run
   * fire-and-forget — and at most once per session and sub-call kind.
   * `message` is the operator notice; `setting` the config key it names.
   * See ../memory/docs/formation.md for sub-call ownership.
   */
  | ({ type: "memory_health_warning" } & MemoryHealthWarning);

export interface RunTurnResult {
  session: SessionState;
  reason: AgentLoopReason;
  stepCount: number;
  /**
   * Set when a ceiling — not the model — ended the task: always on
   * `max_steps`, and on a `reply` / `finish` produced by the forced
   * finalization step (the last step the step or time ceiling allows,
   * where only the terminal tools are offered). A reply written there
   * summarises how far the work got; it is not evidence the work
   * finished. Absent when the model ended the turn on an ordinary step,
   * and on `cancelled` / `failed`. A fusion worker reads it to report
   * `max_steps` rather than `ok` for a worker that ran out of steps and
   * said so in its reply.
   */
  stopCause?: TaskStopCause;
  /**
   * Steering messages that were pushed but never reached a step — the
   * turn ended (or was cancelled) before the loop could drain them.
   * Callers MUST re-route these, normally onto their own message queue,
   * otherwise a message the user watched being accepted vanishes. Empty
   * on every ordinary turn.
   */
  undelivered?: readonly string[];
}
