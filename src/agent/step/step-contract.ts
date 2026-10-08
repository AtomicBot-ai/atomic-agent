import type { PromptMessages, ChatPromptParts, ReasoningEffort, ResponseFormatJsonSchema, ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { StreamChunk, CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ProgressNoteNoticeState } from "../progress-note-reply.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { ToolCallAdapter } from "../../llm/provider/adapters/tool-call-adapter.js";
import type { StepEvent } from "../step-events.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolLoopTracker } from "../loop-detector.js";
import type { BatchApprovalPosture } from "../tool-resource-class.js";
import type { SessionState } from "../../session/session-state.js";
import type { ToolDescriptor, CapabilitiesSummary, SkillCatalogEntry } from "../../prompt/stable-prefix.js";
import type { ProfileFact } from "../../memory/profile-store.js";
import type { StepToolSet } from "../policies/step-tool-set.js";
import type { ToolRole } from "../../tools/tool-roles.js";
import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import type { BuiltPrompt } from "../../prompt/build-prompt.js";
import type { BatchLoopSignal } from "../dispatch/batch-contract.js";


export interface LlmStreamParams {
  contextBudget?: { window: number | null; replyReserve: number };
  /** Rebuild and commit context for the actual attempted policy/window, including fallback. */
  prepareForLink?: (options: {
    modelMode: import("../../llm/model-mode.js").ResolvedModelMode;
    transport: ToolCallTransport;
    contextWindow: number | null;
    maxTokens?: number;
  }) => Pick<LlmStreamParams, "prompt" | "messages" | "chat" | "contextBudget"> &
    Partial<Pick<LlmStreamParams, "tools" | "toolChoice" | "parallelToolCalls" | "grammar" | "maxTokens" | "slotId">>;
  /** Internal policy metadata; never serialized to the provider API. */
  modelModePolicy?: import("../../llm/model-mode.js").ModelModePolicy;
  prompt: string;
  /**
   * The same prompt as structure — stable prefix, packed turns, tail —
   * for a native-tools link that lays history out as real chat messages
   * instead of one user message of transcript text (which Gemini Flash
   * kept continuing as text instead of calling tools). Set only when the
   * primary transport is `native_tools`; the seam forwards it on that
   * transport alone, so a grammar fallback link still gets `prompt` /
   * `grammarPrompt`.
   */
  messages?: PromptMessages;
  /**
   * Lazy grammar-transport variant of `prompt`. Set when `prompt` was
   * built prefill-suppressed for a native-tools primary while the
   * profile still expects the reasoning prefill / turn framing at a
   * text-completion generation point (issue #283). A cross-transport
   * fallover hands this request to a grammar (llama-server) link whose
   * chat template and GBNF prelude assume the open tag is pre-typed —
   * the fallback seam substitutes this variant there, so each link
   * receives the prompt shape its transport expects. A thunk so the
   * second `buildPrompt` only runs if a grammar link is actually chosen;
   * implementations memoize.
   */
  grammarPrompt?: () => string;
  /**
   * The prompt as prefix + tail, for a grammar (llama-server) link that
   * renders through the model's own chat template (F31). Set only when
   * the primary is a grammar link and the server-template policy is on
   * for its profile; the seam forwards it as `CompletionRequest.chat`.
   */
  chat?: ChatPromptParts;
  grammar: string;
  slotId: number;
  /**
   * `cache_prompt` for a llama-server request. Defaults to "when
   * `slotId >= 0`". The main loop sets it `true` even on a pending
   * `slotId: -1` — that pairing asks llama-server to pick the slot by
   * prefix similarity and keep the prompt there — while a side call on
   * `-1` (no pin, no reuse wanted) leaves it unset.
   */
  cachePrompt?: boolean;
  sessionId: string;
  /**
   * Optional `n_predict` cap for this completion. Falls through to
   * `config.localModels.completionMaxTokens` when omitted. Used by the
   * structured-repair retry path to bound a runaway reasoning-loop
   * failure mode (see `REPAIR_MAX_TOKENS` and the call-site comment).
   */
  maxTokens?: number;
  /**
   * The turn's output ceiling (`RunTurnOptions.maxOutputTokens`), below
   * the per-step `maxTokens` above and above the provider's own. A
   * fusion worker's `workerMaxOutputTokens` rides here.
   */
  maxOutputTokens?: number;
  /** The turn's reasoning effort (`RunTurnOptions.reasoningEffort`). */
  reasoningEffort?: ReasoningEffort;
  /** OpenAI tools payload — set when `toolTransport === "native_tools"`. */
  tools?: ReadonlyArray<Record<string, unknown>>;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  /**
   * OpenAI Structured Outputs envelope — the cross-vendor equivalent
   * of `grammar` for cloud providers that cannot honour GBNF.
   * Forwarded to `provider.complete` as `response_format: { type:
   * "json_schema", json_schema: ... }`. Used by reflection / link-gen
   * / vote / rewriter / distill sub-runners to keep cloud outputs
   * parseable. Ignored on the grammar transport (llama-server already
   * gets GBNF via `grammar`).
   */
  responseFormat?: ResponseFormatJsonSchema;
  /**
   * Abort signal for the in-flight completion. Forwarded down to the
   * provider's HTTP request so a user-triggered cancel (Ctrl+C in the
   * TUI, `signal` on `runTurn`) interrupts the LLM call mid-generation
   * instead of waiting for the current step to finish on its own.
   */
  signal?: AbortSignal;
  /**
   * Pins this completion to one configured provider id, bypassing the
   * provider fallback chain entirely. A fusion worker turn runs on the
   * local leg on purpose — it exists to spend local tokens — so the
   * request must reach exactly that provider or fail; it must never be
   * quietly re-routed to the cloud primary. Absent (the normal case)
   * the chain picks the link as before.
   */
  providerId?: string;
}


export type LlmCompleteStream = (
  params: LlmStreamParams,
) => AsyncGenerator<StreamChunk, CompletionResult, void>;


export interface StepDependencies {
  prepareWorkspace?: (session: SessionState, cloud: boolean, signal?: AbortSignal) => import("../../session/workspace-context.js").SessionWorkspace;
  /** Publish completed cloud tool pairs even if the batch then cancels. */
  commitSession?: (state: SessionState) => void;
  modelModePolicy?: import("../../llm/model-mode.js").ModelModePolicy;
  modelMode?: import("../../llm/model-mode.js").ResolvedModelMode;
  registry: ToolRegistry;
  /**
   * Plan mode, read per call rather than captured once — same contract
   * as `BatchExecutionContext.isPlanMode`. Absent ⇒ off.
   */
  isPlanMode?: () => boolean;
  /**
   * Fusion's division of labour, forwarded to the batch context. Set by
   * the loop only for an ORCHESTRATOR turn in fusion mode; a worker's
   * own turn and every other run mode leave all three absent, which
   * gates nothing.
   */
  isFusionOrchestrator?: () => boolean;
  fusionState?: () => import("../fusion-orchestrator-mode.js").FusionOrchestratorState;
  onDelegated?: (result: CompressedToolResult) => void;
  /**
   * Claims need evidence (`claim-evidence.ts`). Per-turn state held by
   * the loop: whether this turn has already been told once that a reply
   * claimed a check that never ran. Absent ⇒ replies are never held.
   */
  claimEvidence?: { noticed: () => boolean; markNoticed: () => void };
  /**
   * Links need a source (`link-evidence.ts`). Per-turn state held by the
   * loop: whether this turn has already been told once that a reply
   * carried a link no tool result holds. Absent ⇒ links are not checked.
   */
  linkEvidence?: { noticed: () => boolean; markNoticed: () => void };
  /**
   * Per-turn state for the progress-note notice
   * (`progress-note-reply.ts`): whether this turn was already told that
   * a `reply` batched with work was kept as a note. Absent ⇒ the notice
   * accompanies every note.
   */
  progressNotes?: ProgressNoteNoticeState;
  slotManager: SlotManager;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  /**
   * Optional streaming sibling of `llmComplete`. When present, the step
   * executor consumes the SSE stream and emits `reasoning_delta` and
   * `assistant_delta` events live. Final `reasoning` / `assistant_reply`
   * emissions stay identical to the unary path so downstream consumers
   * never observe behaviour drift when streaming is disabled.
   */
  llmCompleteStream?: LlmCompleteStream;
  grammar: string;
  profile: ModelProfile;
  /**
   * The model's context window when the profile probe cannot supply it.
   *
   * `profile.contextWindow` comes from llama-server `/props`, so on a
   * cloud provider the budget had no window and every window-relative
   * decision fell back to a fixed number. Resolved from the model
   * catalogue instead — and only when the catalogue actually knows,
   * never from a nominal default, because a budget computed against a
   * guessed window is worse than one that admits it has none.
   */
  contextWindow?: number | null;
  /**
   * Whether `profile.contextWindow` describes the model serving THIS
   * step. Default `true`. The agent loop answers it from the link the
   * step is routed to: a Fusion orchestrator running on a cloud leg
   * holds a llama-server profile for its workers, and budgeting its own
   * prompt against the workers' per-slot `n_ctx` is how a 128k model
   * ended up packed to 16k. See `BuildPromptInput.profileWindowApplies`.
   */
  profileWindowApplies?: boolean;
  /**
   * The local worker leg's request-slot count as the server reported
   * it, `null` until observed — forwarded to `buildPrompt` for the
   * `### fusion` machine facts. See `AgentLoopDeps.liveWorkerSlots`.
   */
  liveWorkerSlots?: () => number | null;
  /** Effective transport for this runtime (grammar vs native OpenAI tools). */
  toolTransport: ToolCallTransport;
  /** Adapter for native_tools; null when grammar-only. */
  toolCallAdapter: ToolCallAdapter | null;
  /** When false, completions use slotId -1 (cloud providers). */
  supportsSlotAffinity: boolean;
  /**
   * The local daemon's measured decode speed for the `### fusion` machine
   * facts (`ModelProfileManager.getTokensPerSecond`). Read per step;
   * absent or `null` states nothing.
   */
  fusionTokensPerSecond?: () => number | null;
  /**
   * Provider capability: whether the active native-tools provider can
   * generate parallel tool calls in one response. When false (or the
   * configured `agent.maxParallelToolCalls` is 1), the executor asks
   * the provider for a single tool call per response by sending
   * `parallel_tool_calls: false`. Defaults to `true` for legacy /
   * grammar-only wiring.
   */
  supportsParallelTools?: boolean;
  /**
   * The resolved model declares `supportsTools: "strict"`, so the
   * native-tools request asks the provider to constrain the decode to
   * the tool schemas. Off unless the operator sets that level by hand
   * on a `llm.providers[].userModels[]` entry; the adapter still
   * refuses per tool whatever it cannot express strictly.
   */
  strictTools?: boolean;
  /**
   * Provider pin for every completion this step issues (initial call
   * and repair retry alike). Forwarded verbatim as
   * `LlmStreamParams.providerId`; see that field for the contract.
   */
  providerId?: string;
  /**
   * Invoked after every LLM completion (initial call and one-shot parse
   * retry alike). Used by the agent loop to feed the served `modelId`
   * into the profile manager so mid-turn model swaps can be detected.
   */
  onCompletion?: (completion: CompletionResult) => void;
  onEvent?: (event: StepEvent) => void;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
  /**
   * Per-turn loop tracker. Threaded into `executeBatch` so the
   * synchronous loop gate can veto no-progress calls before dispatch.
   * Absent ⇒ loop detection disabled for this step.
   */
  tracker?: ToolLoopTracker;
  /**
   * The session's live approval posture, read when a batch holds
   * approval-gated calls. When every gated call in the batch would run
   * without a prompt (see `gatedCallRunsUnattended`), the batch runs
   * one call after another in emitted order instead of being trimmed to
   * its first gated call. When one would prompt, an eligible batch runs
   * behind approval barriers (`executeWithApprovalBarriers`) and the
   * rest is trimmed as before. Absent ⇒ today's trim. The `ApprovalGate`
   * satisfies this shape: `{ getLevel: () => gate.getLevel(),
   * sessionGrants: (id) => gate.sessionGrants(id) }`.
   */
  approvalPosture?: StepApprovalPostureSource;
}


/** Where the step reads the approval posture from — structurally an `ApprovalGate`. */
export interface StepApprovalPostureSource {
  getLevel(): BatchApprovalPosture["level"];
  sessionGrants?(sessionId: string): {
    categories: NonNullable<BatchApprovalPosture["grantedCategories"]>;
  };
}


export interface StepContext {
  workspace?: import("../../session/workspace-context.js").SessionWorkspace;
  session: SessionState;
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  /** Installed skills the catalog budget left out (issue #466). */
  skillCatalogDropped?: number;
  stepIndex: number;
  signal: AbortSignal;
  /**
   * Signal for the step's completion request(s) only: the user's
   * `signal` composed with the task's remaining wall-clock time (see
   * `request-deadline.ts`). Absent, the request runs on `signal`. Tool
   * execution never sees it — the loop decides what a fired deadline
   * means, and it means `time_ceiling`, not a cancelled tool.
   */
  requestSignal?: AbortSignal;
  /**
   * Optional one-shot notice to render in the prompt's `### notice`
   * section for this step only. The agent loop uses this to warn the
   * model about detected no-progress loops. Lives in the variable tail,
   * never in the stable prefix.
   */
  transientNotice?: string;
  /**
   * Durable user profile facts snapshotted at step-start. Rendered into
   * the `### profile` section of the prompt tail. `undefined` suppresses
   * the section entirely (memory fabric not wired).
   */
  profileFacts?: readonly ProfileFact[];
  /**
   * Current user message for the turn. Threaded through `buildPrompt`
   * so the profile renderer can gate contextual (pinned=false) facts by
   * keyword match. `null` means the turn has no user text (tool-only
   * continuation) — contextual facts stay suppressed.
   */
  userMessage?: string | null;
  /**
   * The operator's request behind this turn (`RunTurnOptions.originalRequest`),
   * pinned into the prompt as `### request` once the packer has dropped
   * the turn that carried it. See `request-section.ts`.
   */
  originalRequest?: string;
  /** `RunTurnOptions.routeNote`, rendered as `### route` (`build-prompt.ts`). */
  routeNote?: string;
  /** The turn's reasoning effort — see `LlmStreamParams.reasoningEffort`. */
  reasoningEffort?: ReasoningEffort;
  /** The turn's output ceiling — see `LlmStreamParams.maxOutputTokens`. */
  maxOutputTokens?: number;
  /**
   * Only the terminal `reply`/`finish` tools may run this step (the
   * loop's reserved final step). The prompt's tool catalog is left as it
   * is — it is stable-prefix bytes, and narrowing it for one step moved
   * the session to a cold slot — so the restriction is enforced where a
   * call would run: a non-terminal call gets a refusal as its tool
   * result (`batch-executor.ts`), a tail terminal still lands.
   */
  terminalOnly?: boolean;
  /**
   * The only tool names this step may emit or run (`step-tool-set.ts`)
   * — `terminalOnly` with the names supplied. Narrows the per-request
   * grammar and the native tools payload below the role's list, and the
   * batch executor refuses a call outside it; the prompt's catalog is
   * untouched. The loop sets it for a stalled Fusion review's cut step
   * (`review-stall.ts`).
   */
  toolSet?: StepToolSet;
  /**
   * The turn's `RunTurnOptions.toolFilter`, when one is set. The loop has
   * already applied it to `toolDescriptors`; the step applies it once
   * more to the per-request grammar, so a hidden tool is not merely
   * absent from the catalog but impossible for a local model to emit —
   * `finish` included, which the static grammar lists unconditionally.
   */
  toolFilter?: (name: string) => boolean;
  /**
   * The turn's tool role (`tool-roles.ts`). Decides which of
   * `toolDescriptors` the prompt describes in full (the rest become one
   * line of names), which go on the native wire, and which the grammar
   * admits — the role's own plus whatever the session has loaded through
   * `tool.view`. Absent ⇒ `full`, byte-identical to before roles existed.
   */
  toolRole?: ToolRole;
  /**
   * Reply cap for this step's completions, in place of
   * `localModels.completionMaxTokens`. The agent loop sets it when the
   * previous attempt at this very step came back cut off by the cap
   * (`planTruncationRetry`); nothing else overrides the config.
   */
  maxTokens?: number;
}


/**
 * Why a step ended the current macro-turn or the whole session.
 *  - `null`: ordinary tool call, the loop should continue.
 *  - `"turn"`: model emitted `reply` — close the turn, keep session alive.
 *  - `"session"`: model emitted `finish` — close the session entirely.
 */
export type StepTerminal = "turn" | "session" | null;


/**
 * Outcome of a single inference step.
 *
 * `toolCalls` / `toolResults` always have length ≥ 1 and are aligned
 * by index (the result at `toolResults[i]` corresponds to the call at
 * `toolCalls[i]`). For the legacy single-call path both arrays have
 * length 1; for a batched step both arrays have N entries in
 * batch-index order (the order the model emitted them).
 *
 * `terminal` is set when the **last** call in the batch is a terminal
 * verb (`reply` / `finish`) or returns a result that flags itself as
 * final. Terminal verbs are allowed only at the tail of a multi-call
 * batch (the validator rejects them anywhere else); a `terminal !==
 * null` outcome means the loop should close the turn/session after
 * this step.
 */
export interface StepOutcome {
  toolCalls: ToolCallPayload[];
  toolResults: CompressedToolResult[];
  completion: CompletionResult;
  prompt: BuiltPrompt;
  nextSession: SessionState;
  terminal: StepTerminal;
  /**
   * Loop-detection signals raised by the batch executor's synchronous
   * gate this step (warn / critical / breaker). Empty when no tracker
   * was supplied or no loop was detected. The agent loop consumes these
   * to inject notices and trigger the graceful breaker termination.
   */
  loopSignals: BatchLoopSignal[];
  /**
   * Next-step notice for a change the runtime made to this step's
   * emission, meant to be injected into the next step's
   * `transientNotice`. Set in two cases (joined when both happen):
   *  - the parsed batch failed validation purely because it contained
   *    approval-gated tools that could prompt, and the runtime auto-split
   *    it to a length-1 execution (the first approval-gated call) — the
   *    notice lists the dropped calls so the model can retry them
   *    one-by-one. Distinct from `parse_retry`: no LLM round-trip.
   *  - the completion wrote tool calls / results as plain text
   *    (`detectFabricatedToolTranscript`): its `reply` / `finish` was not
   *    accepted and the notice says none of that text ran.
   *  - a `reply` batched with work tools was kept as a progress note
   *    (`progressNote`), once per turn.
   *  - a batch run behind approval barriers stopped at a gated call that
   *    was not approved or failed: the notice names that call and the
   *    calls after it that never ran (`formatApprovalBarrierNotice`).
   * The name predates the later cases; the agent loop already routes it
   * to the next step, which is all any of them needs.
   */
  trimmedBatchNotice?: string;
  /**
   * Notice text injected into the NEXT step's `transientNotice` when
   * `executeStepInner` mechanically split an oversized pure-read batch
   * into bounded waves (issue #111). Same lifecycle as
   * `trimmedBatchNotice`: set only when the split fires, left undefined
   * otherwise so the agent loop does not overwrite a higher-priority
   * pending notice.
   */
  waveSplitNotice?: string;
  /**
   * The text of a `reply` the model batched with work tools this step.
   * It was kept as a progress note — `toolResults` carries an `ok`
   * `reply` result with `details.progressNote`, the transcript a flagged
   * `assistant_reply` row — and `terminal` is `null`: the turn goes on
   * (`progress-note-reply.ts`).
   */
  progressNote?: string;
}
