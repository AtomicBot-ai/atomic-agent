import {
  extractReasoning,
  parseToolCalls,
  ToolCallParseError,
} from "../llm/grammar/tool-call-grammar.js";
import type {
  ToolCallBatch,
  ToolCallPayload,
} from "../llm/grammar/tool-call-grammar.js";
import {
  executeBatch,
  toBatchInputs,
  type BatchLoopSignal,
} from "./batch-executor.js";
import type { ToolLoopTracker } from "./loop-detector.js";
import {
  isBatchable,
  resourceClassFor,
} from "./tool-resource-class.js";
import { createStreamParser } from "../llm/grammar/stream-parser.js";
import type { StreamParseEvent } from "../llm/grammar/stream-parser.js";
import { checkProfilePromptAligned } from "../llm/profile-invariants.js";
import {
  CancelledError,
  GrammarError,
  LlmFailure,
  LlamaServerError,
  ModelError,
  OpenAiHttpError,
  ToolExecutionError,
  TransportError,
  classifyFailure,
  detectModelFailure,
  humanizeOpenAiHttpError,
} from "../llm/index.js";
import { getConfig } from "../config/index.js";
import {
  getToolDescriptorByName,
  isRareToolName,
} from "../prompt/tool-descriptors.js";
import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";
import { validateJsonSchemaValue } from "../llm/provider/openai/coerce-json-schema-value.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuiltPrompt } from "../prompt/build-prompt.js";
import { formatCurrentDate } from "../prompt/current-date.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import type { SessionState } from "../session/session-state.js";
import {
  recordLatestResult,
  recordLoadedSkill,
  recordLoadedTool,
  recordTurn,
  recordWorldSnapshot,
} from "../session/session-state.js";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
} from "../session/conversation-turn.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { hashPrefix, type SlotManager } from "../llm/slot-manager.js";
import {
  getReasoningTurnFraming,
  reasoningOpenEmittedByModel,
  type ModelProfile,
} from "../llm/model-profile.js";
import type {
  ResponseFormatJsonSchema,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import type { ToolCallAdapter } from "../llm/provider/adapters/tool-call-adapter.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { StepEvent } from "./step-events.js";
export type { PromptCapturedTokens, StepEvent } from "./step-events.js";

export interface LlmStreamParams {
  prompt: string;
  grammar: string;
  slotId: number;
  sessionId: string;
  /**
   * Optional `n_predict` cap for this completion. Falls through to
   * `config.localModels.completionMaxTokens` when omitted. Used by the
   * structured-repair retry path to bound a runaway reasoning-loop
   * failure mode (see `REPAIR_MAX_TOKENS` and the call-site comment).
   */
  maxTokens?: number;
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
}

export type LlmCompleteStream = (
  params: LlmStreamParams,
) => AsyncGenerator<StreamChunk, CompletionResult, void>;

export interface StepDependencies {
  registry: ToolRegistry;
  /**
   * Plan mode, read per call rather than captured once — same contract
   * as `BatchExecutionContext.isPlanMode`. Absent ⇒ off.
   */
  isPlanMode?: () => boolean;
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
  /** Effective transport for this runtime (grammar vs native OpenAI tools). */
  toolTransport: ToolCallTransport;
  /** Adapter for native_tools; null when grammar-only. */
  toolCallAdapter: ToolCallAdapter | null;
  /** When false, completions use slotId -1 (cloud providers). */
  supportsSlotAffinity: boolean;
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
}

export interface StepContext {
  session: SessionState;
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  stepIndex: number;
  signal: AbortSignal;
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
   * Set when the step's parsed batch failed validation purely because
   * it contained approval-gated tools. The runtime auto-split the batch
   * to a length-1 execution (the first approval-gated call); this notice
   * is meant to be injected into the next step's `transientNotice` so
   * the model knows which calls were dropped and can retry them
   * one-by-one. Distinct from `parse_retry` — no LLM round-trip
   * happened for the trim.
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
}

/**
 * Most tool calls one emission may run after a wave split. Generous
 * enough for any honest fan-out (a repo-wide read, a batch of searches)
 * and small enough that a hallucinated array goes back to the model
 * instead of hitting the network 120 times.
 */
const MAX_WAVE_SPLIT_CALLS = 32;

/** Validation failure for a multi-call batch (forbidden tool / oversized / unknown). */
export class BatchValidationError extends Error {
  constructor(
    message: string,
    /** Per-call error reason, indexed by `batchIndex`. `null` ⇒ this call was fine. */
    public readonly perCall: Array<string | null>,
  ) {
    super(message);
    this.name = "BatchValidationError";
  }
}

/**
 * Executes exactly one agent step: builds the prompt, calls the LLM under
 * the GBNF grammar, parses the resulting tool call, runs the tool,
 * appends `assistant_tool_call` + `tool_result` (or `assistant_reply`)
 * turns to the conversation, and returns the updated session state.
 *
 * Any terminal failure is normalised into an `LlmFailure` subclass before
 * the `step_error` event fires, so downstream consumers (traces, metrics,
 * TUI) can rely on the `category` field without running their own
 * classifier.
 */
export async function executeStep(
  ctx: StepContext,
  deps: StepDependencies,
): Promise<StepOutcome> {
  try {
    return await executeStepInner(ctx, deps);
  } catch (err) {
    const failure = toLlmFailure(err, ctx);
    deps.onEvent?.({
      type: "step_error",
      error: failure,
      category: failure.category,
    });
    throw failure;
  }
}

async function executeStepInner(
  ctx: StepContext,
  deps: StepDependencies,
): Promise<StepOutcome> {
  const prompt = buildPrompt({
    session: ctx.session,
    toolDescriptors: ctx.toolDescriptors,
    capabilities: ctx.capabilities,
    skillCatalog: ctx.skillCatalog,
    currentDate: formatCurrentDate(new Date()),
    profile: deps.profile,
    ...(ctx.transientNotice !== undefined
      ? { transientNotice: ctx.transientNotice }
      : {}),
    ...(ctx.profileFacts !== undefined
      ? { profileFacts: ctx.profileFacts }
      : {}),
    ...(ctx.userMessage !== undefined
      ? { userMessage: ctx.userMessage }
      : {}),
  });
  const slot = deps.supportsSlotAffinity
    ? deps.slotManager.acquire(ctx.session.id, prompt.stablePrefix)
    : {
        slotId: -1,
        prefixHash: hashPrefix(prompt.stablePrefix),
        firstSeenAt: Date.now(),
        cacheReused: false,
      };
  if (ctx.stepIndex === 0) {
    const promptViolations = checkProfilePromptAligned(deps.profile, prompt.text);
    if (promptViolations.length > 0) {
      deps.logger?.warn("profile/prompt invariant violated", {
        profile: deps.profile.id,
        sessionId: ctx.session.id,
        violations: promptViolations,
      });
    }
  }
  deps.onEvent?.({ type: "prompt_built", prompt, slotId: slot.slotId });
  deps.onEvent?.({
    type: "prompt_captured",
    stepIndex: ctx.stepIndex,
    stablePrefixHash: hashPrefix(prompt.stablePrefix),
    tail: prompt.tail,
    tokens: {
      total: prompt.tokens.total,
      stablePrefix: prompt.tokens.stablePrefix,
      tail: Math.max(0, prompt.tokens.total - prompt.tokens.stablePrefix),
    },
    slotId: slot.slotId,
    cacheReused: slot.cacheReused,
  });
  deps.logger?.debug("prompt built", {
    sessionId: ctx.session.id,
    slotId: slot.slotId,
    cacheReused: slot.cacheReused,
    promptTokens: prompt.tokens.total,
  });

  const llmParams: LlmStreamParams = buildLlmStreamParams({
    promptText: prompt.text,
    deps,
    slotId: slot.slotId,
    sessionId: ctx.session.id,
    toolDescriptors: ctx.toolDescriptors,
    signal: ctx.signal,
  });

  const firstAttempt = await runInitialCompletion({
    ctx,
    deps,
    prompt,
    slot,
    llmParams,
  });
  let completion = firstAttempt.completion;

  // Prefer the dedicated `reasoning_content` channel when the server
  // (QwQ, DeepSeek-R1 with `--reasoning-format deepseek`) supplies it —
  // the content body then no longer embeds `<think>...</think>` blocks.
  // Fall back to extracting `<think>` from `content` for classic builds
  // and models that stream CoT inline.
  let reasoning = resolveReasoning(completion, deps.profile);
  if (reasoning.length > 0) {
    deps.onEvent?.({
      type: "reasoning",
      stepIndex: ctx.stepIndex,
      text: reasoning,
    });
  }

  // Detect model-side defects before the parser wastes a retry on a
  // fundamentally broken completion (truncated / empty / no_stop). Native
  // tool-call providers are the exception for reasoning-only empty bodies:
  // the model may have thought but failed to emit a required tool call, and
  // the existing repair path can recover with a stricter one-shot prompt.
  const initialModelFailure = detectModelFailure(completion);
  if (initialModelFailure !== null) {
    const initialParseDeps = parseDepsFor(completion, deps);
    const repairable = isGrammarEmptyCompletionWorthRepairing(
      initialParseDeps,
      initialModelFailure.reason,
    );
    if (
      !repairable &&
      !isNativeToolsEmptyCompletionHandledByParser(
        initialParseDeps,
        initialModelFailure.reason,
        completion,
      )
    ) {
      deps.logger?.warn("model-side completion defect", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        reason: initialModelFailure.reason,
      });
      throw new ModelError(
        initialModelFailure.reason,
        initialModelFailure.message,
      );
    }
    if (repairable) {
      // Fall through to the parser: an empty body fails to parse, which
      // routes into the one-shot repair below. The repair's own
      // `detectModelFailure` still throws `ModelError` if the second
      // completion is empty too, so "twice empty" remains terminal.
      deps.logger?.warn("empty completion, repairing once", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
      });
    }
  }

  // Notice text injected into the NEXT step's `transientNotice` when
  // `executeStepInner` auto-trims a multi-call batch. Set only when the
  // trim fires; left undefined otherwise so the agent loop knows not to
  // overwrite a higher-priority pending notice (loop-detector hint).
  let trimmedBatchNotice: string | undefined;

  // Same lifecycle for the wave-split path: when an oversized pure-read
  // batch was mechanically split (issue #111), tell the model on the
  // next step so it understands its array ran in bounded waves rather
  // than all-at-once.
  let waveSplitNotice: string | undefined;

  /**
   * Inline helper: if a `BatchValidationError` is purely about
   * approval-gated tools batched together, trim the batch to the first
   * approval-gated call (length-1), emit the observability event, and
   * capture the notice for the next step. Returns the trimmed batch
   * paired with a fresh `ok: true` parse result, or `null` if the
   * failure is not trim-eligible (terminal verbs, oversized, unknown
   * resource class — those still go through the LLM repair path).
   */
  const tryTrimApprovalGated = (
    batch: ToolCallBatch,
    error: BatchValidationError,
  ): { ok: true; batch: ToolCallBatch } | null => {
    // An oversized batch is never trim-eligible, even when its only
    // per-call reason is approval-gated (e.g. `[os.fs.write, 13 reads]`
    // with a cap of 8). Trimming would keep the write solo and silently
    // drop the 13 reads the model asked for; the oversized case must go
    // through the LLM repair path (or the wave split below) instead.
    if (batch.calls.length > getConfig().agent.maxParallelToolCalls) {
      return null;
    }
    if (!isApprovalGatedOnlyFailure(error)) return null;
    const trim = trimBatchToFirstApprovalGated(batch);
    if (trim === null) return null;
    trimmedBatchNotice = formatBatchTrimNotice(trim);
    deps.onEvent?.({
      type: "batch_trimmed",
      stepIndex: ctx.stepIndex,
      originalSize: trim.originalSize,
      kept: trim.kept.tool,
      dropped: trim.dropped.map((call) => call.tool),
      reason: "approval-gated-batched",
    });
    deps.metrics?.recordBatchTrimmed({
      sessionId: ctx.session.id,
      reason: "approval-gated-batched",
      originalSize: trim.originalSize,
      droppedCount: trim.dropped.length,
    });
    deps.logger?.info("batch trimmed to first approval-gated call", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      originalSize: trim.originalSize,
      kept: trim.kept.tool,
      dropped: trim.dropped.map((call) => call.tool),
    });
    return {
      ok: true,
      batch: { ...batch, calls: [trim.kept] },
    };
  };

  /**
   * Inline helper: mechanically split an oversized pure-read batch into
   * bounded waves (issue #111). Eligibility is strict — the batch must
   * be larger than `agent.maxParallelToolCalls` AND every call must
   * preflight as registered, argument-schema-valid, and classified
   * `pure_read`. A single non-`pure_read` call (approval-gated,
   * terminal, unknown class) or a schema-invalid arg kicks the batch
   * back to the LLM repair path, because wave-splitting would execute
   * calls the runtime is not allowed to batch (consent / ordering /
   * semantic intent the model is better placed to reconcile).
   */
  const trySplitPureReadWaves = (
    batch: ToolCallBatch,
  ): { ok: true; batch: ToolCallBatch } | null => {
    const cap = getConfig().agent.maxParallelToolCalls;
    const calls = batch.calls;
    if (calls.length <= cap) return null;
    // A ceiling, because "run it in waves" is not a licence to execute
    // an arbitrary array. A model that derails and emits 120 searches
    // would otherwise have every one run — 120 live requests and 240
    // transcript turns out of a single hallucinated emission — and the
    // loop detector cannot intervene: its gate runs once, before the
    // first call of the batch. Past the ceiling the batch goes back to
    // the model, which is what an oversized batch did before waves
    // existed.
    //
    // The ceiling counts CALLS, not waves: with a cap of 1 a fan-out of
    // fourteen reads is fourteen waves and perfectly reasonable, while
    // with a cap of 8 the same wave count would be 112 live requests.
    // What matters is how much work one emission can start.
    if (calls.length > MAX_WAVE_SPLIT_CALLS) return null;
    for (const call of calls) {
      if (resourceClassFor(call.tool) !== "pure_read") return null;
      if (!callArgsSchemaValid(call, ctx.toolDescriptors)) return null;
    }
    const waveCount = Math.ceil(calls.length / cap);
    const boundaries = Array.from(
      { length: waveCount },
      (_, i) => i * cap,
    );
    waveSplitNotice = formatWaveSplitNotice(calls.length, cap, waveCount);
    deps.onEvent?.({
      type: "batch_wave_split",
      stepIndex: ctx.stepIndex,
      originalSize: calls.length,
      cap,
      waveCount,
      boundaries,
    });
    deps.metrics?.recordBatchWaveSplit({
      sessionId: ctx.session.id,
      originalSize: calls.length,
      cap,
      waveCount,
    });
    deps.logger?.info("oversized pure-read batch split into bounded waves", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      originalSize: calls.length,
      cap,
      waveCount,
    });
    return {
      ok: true,
      batch: { ...batch, maxWaveSize: cap },
    };
  };

  let parsed = tryParseToolCalls(
    completion,
    deps.profile,
    parseDepsFor(completion, deps),
  );
  if (parsed.ok) {
    const validation = validateBatch(parsed.batch, deps.registry);
    if (!validation.ok) {
      // Try the cheap mechanical fixes first, in order:
      //   1. Wave split (issue #111): an oversized batch whose calls
      //      are ALL `pure_read` and schema-valid runs deterministically
      //      in bounded waves — no LLM repair round-trip.
      //   2. Approval-gated trim: a batch whose only failure is
      //      "approval-gated tools must be solo" (and is NOT oversized)
      //      trims to the first approval-gated call.
      // Anything else (terminal verbs in a batch, oversized mixed
      // batches, unknown resource class) still routes through the model
      // so it can re-plan.
      const split = trySplitPureReadWaves(parsed.batch);
      if (split !== null) {
        parsed = split;
      } else {
        const trimmed = tryTrimApprovalGated(parsed.batch, validation.error);
        if (trimmed !== null) {
          parsed = trimmed;
        } else {
          parsed = { ok: false, error: validation.error };
        }
      }
    }
  }

  if (!parsed.ok) {
    // One-shot repair: grammar outputs can be truncated or malformed for
    // transient reasons (stop-sequence race, model hiccup), and a batch
    // can fail validation when the model puts an approval-gated or
    // terminal verb inside an array. The repair call replays through the
    // unary LLM path with a short corrective notice appended — the
    // streaming path has already flushed partial deltas, so replaying
    // through it would double-emit.
    deps.onEvent?.({
      type: "parse_retry",
      stepIndex: ctx.stepIndex,
      attempt: 1,
      reason: parsed.error.message,
    });
    deps.logger?.warn("tool-call parse failed, repairing once", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      reason: parsed.error.message,
    });

    const retryStartedAt = Date.now();
    completion = await deps.llmComplete({
      ...llmParams,
      prompt: buildToolCallRepairPrompt(prompt.text, parsed.error, deps.profile),
      // Bounded cap on the repair completion. Without it, reasoning
      // models (qwen-3.5-9b in particular) routinely fall into a
      // self-deliberation loop after a `BatchValidationError` and burn
      // the full `completionMaxTokens` (8192) generating dozens of
      // duplicated JSON candidates wrapped in "wait, let me reconsider"
      // prose — that's 3-5 minutes of wall time per repair on a 9B
      // model and the slot stays busy the entire time, cascading into
      // 0-step timeouts on subsequent eval cases.
      //
      // The cap was originally 512 but production traces of a
      // multi-file rename refactor showed legitimate single-call
      // `os.fs.edit` repairs (absolute path in a deep temp dir +
      // realistic `oldString`/`newString`) hitting exactly that
      // ceiling, truncating mid-JSON, and surfacing as
      // `GrammarError: tool-call body is empty`. 1024 keeps the
      // anti-loop guard (still well under `completionMaxTokens=8192`)
      // while leaving room for one full edit call in the worst case.
      maxTokens: REPAIR_MAX_TOKENS,
    });
    const retryDurationMs = Date.now() - retryStartedAt;
    deps.onCompletion?.(completion);
    deps.onEvent?.({ type: "llm_completed", completion });
    deps.onEvent?.({
      type: "llm_raw_completion",
      stepIndex: ctx.stepIndex,
      attempt: 2,
      completion,
    });
    deps.metrics?.recordLlmCall({
      sessionId: ctx.session.id,
      promptTokens: completion.timing?.promptTokens ?? prompt.tokens.total,
      completionTokens: completion.timing?.predictedTokens ?? 0,
      durationMs: retryDurationMs,
      cacheReused: slot.cacheReused,
    });

    const retryReasoning = resolveReasoning(completion, deps.profile);
    if (retryReasoning.length > 0) {
      deps.onEvent?.({
        type: "reasoning",
        stepIndex: ctx.stepIndex,
        text: retryReasoning,
      });
      reasoning = retryReasoning;
    }

    // Same defensive check on the retry completion. If the model produced
    // a truncated or empty reply on the second attempt, it is a model
    // failure, not a grammar one — no point emitting `GrammarError` for
    // an empty body.
    const retryModelFailure = detectModelFailure(completion);
    if (
      retryModelFailure !== null &&
      !isNativeToolsEmptyCompletionHandledByParser(
        parseDepsFor(completion, deps),
        retryModelFailure.reason,
        completion,
      )
    ) {
      deps.logger?.warn("model-side completion defect on parse retry", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        reason: retryModelFailure.reason,
      });
      throw new ModelError(
        retryModelFailure.reason,
        retryModelFailure.message,
      );
    }

    parsed = tryParseToolCalls(
      completion,
      deps.profile,
      parseDepsFor(completion, deps),
    );
    if (parsed.ok) {
      const validation = validateBatch(parsed.batch, deps.registry);
      if (!validation.ok) {
        // Same mechanical-fix shortcuts for the post-repair attempt:
        // if the model came back from repair with another oversized
        // pure-read batch (wave split) or another approval-gated batch
        // (trim), fix it mechanically instead of escalating to
        // `GrammarError`. Surfaces in the same event/metric pair.
        const split = trySplitPureReadWaves(parsed.batch);
        if (split !== null) {
          parsed = split;
        } else {
          const trimmed = tryTrimApprovalGated(parsed.batch, validation.error);
          if (trimmed !== null) {
            parsed = trimmed;
          } else {
            parsed = { ok: false, error: validation.error };
          }
        }
      }
    }
    if (!parsed.ok) {
      deps.logger?.warn("tool-call parse failed after retry", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        rawLength: completion.content.length,
        raw: completion.content,
      });
      // Last resort: the model talked instead of emitting a call (small
      // models routinely answer "hi" in plain prose even under the
      // grammar). Wrap that prose as a `reply` so the turn closes with
      // the model's text — same degradation the `native_tools` path
      // already applies — instead of failing the whole loop. Only
      // reasoning came back? Then there is no answer to deliver and the
      // `GrammarError` still stands.
      const fallback = replyFallbackBatch(completion, deps.profile);
      if (fallback === null) {
        throw new GrammarError(
          parsed.error.message,
          rawPreview(completion.content),
          { cause: parsed.error },
        );
      }
      deps.logger?.warn("degrading unparseable completion to a reply", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        reason: parsed.error.message,
      });
      parsed = { ok: true, batch: fallback };
    }
  }
  const batch = parsed.batch;
  const calls = batch.calls;
  const batchSize = calls.length;

  // Registry membership: surfaces as `ToolExecutionError` (category
  // `tool`) instead of `BatchValidationError`. A missing tool is a
  // bootstrap-time configuration mismatch, not a transient grammar
  // failure — replaying the prompt would not change the registry.
  for (const call of calls) {
    if (!deps.registry.has(call.tool)) {
      throw new ToolExecutionError(
        call.tool,
        `tool not registered in this agent: ${call.tool}`,
      );
    }
  }

  // Emit one `tool_call_parsed` per call. Single-call steps preserve the
  // legacy ordering (parsed → executed → next event) one-for-one;
  // batched steps emit all parsed events first, then execution-order
  // results. Consumers correlate via `batchIndex` / `batchSize`.
  for (let i = 0; i < calls.length; i += 1) {
    deps.onEvent?.({
      type: "tool_call_parsed",
      call: calls[i]!,
      batchIndex: i,
      batchSize,
    });
  }

  const stepStartedAt = Date.now();
  const inputs = toBatchInputs(calls);
  // Names of skills already loaded this session: a `skill.view` for any of
  // these is short-circuited inside `executeBatch` with a terse pointer
  // instead of re-reading and re-dumping the body.
  const loadedSkillNames = new Set(
    ctx.session.loadedSkills.map((s) => s.name),
  );
  const batchOutcome = await executeBatch(inputs, deps.registry, {
    workingDir: ctx.session.workingDir,
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    signal: ctx.signal,
    ...(deps.tracker ? { tracker: deps.tracker } : {}),
    ...(deps.isPlanMode ? { isPlanMode: deps.isPlanMode } : {}),
    ...(batch.maxWaveSize !== undefined ? { maxWaveSize: batch.maxWaveSize } : {}),
    ...(loadedSkillNames.size > 0 ? { loadedSkillNames } : {}),
    onCallFinished: ({ batchIndex, result, durationMs }) => {
      deps.onEvent?.({
        type: "tool_call_executed",
        result,
        batchIndex,
        batchSize,
      });
      deps.metrics?.recordTool({
        sessionId: ctx.session.id,
        tool: result.tool,
        status: result.status,
        durationMs,
      });
      deps.logger?.info("tool executed", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        batchIndex,
        batchSize,
        tool: result.tool,
        status: result.status,
        durationMs,
      });
    },
  });
  const stepDurationMs = Date.now() - stepStartedAt;

  // Materialise per-call results in batch-index order. Cancelled tail
  // calls are folded into a synthetic error result so the transcript
  // and `applyStateEffects` stay in lockstep with `toolCalls.length`.
  const toolResults: CompressedToolResult[] = batchOutcome.results.map(
    (slot, idx): CompressedToolResult => {
      if (slot.compressed) return slot.compressed;
      return compressToolResult({
        tool: slot.call.tool,
        status: "error",
        output: `cancelled before invocation (batch index ${idx})`,
        details: { cancelled: true },
      });
    },
  );

  let workSession: SessionState = {
    ...ctx.session,
    stepCount: ctx.session.stepCount + 1,
  };

  // Per-failed-rare autoload, applied in batch-index order. Successful
  // rare calls feed `recordLoadedTool` via `details.toolLoaded` in
  // `applyStateEffects` below.
  for (let i = 0; i < toolResults.length; i += 1) {
    const result = toolResults[i]!;
    const call = calls[i]!;
    if (
      result.status === "error" &&
      getConfig().agent.autoExpandRareOnError &&
      isRareToolName(call.tool) &&
      !workSession.loadedTools.some((t) => t.name === call.tool)
    ) {
      const d = getToolDescriptorByName(call.tool);
      if (d && d.tier === "rare") {
        workSession = recordLoadedTool(
          workSession,
          {
            name: d.name,
            summary: d.summary,
            argsSchema: d.argsSchema,
            ...(d.examples && d.examples.length > 0
              ? { examples: d.examples }
              : {}),
            source: "auto",
          },
          getConfig().agent.loadedToolsCap,
        );
        deps.onEvent?.({
          type: "rare_tool_autoloaded",
          tool: call.tool,
          source: "auto",
          stepIndex: ctx.stepIndex,
        });
      }
    }
  }

  // Apply state effects in batch-index order. `recordLatestResult` is
  // called on every result (last writer wins, deterministic). World
  // snapshot updates from multiple results collapse to last writer
  // by index.
  let nextSession: SessionState = workSession;
  for (let i = 0; i < toolResults.length; i += 1) {
    const result = toolResults[i]!;
    nextSession = recordLatestResult(nextSession, {
      tool: result.tool,
      status: result.status,
      summary: result.summary,
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
    nextSession = applyStateEffects(nextSession, result);
  }

  // Terminal classification looks at the **last** call of the batch:
  // the validator guarantees a terminal verb can only appear at the
  // tail, and the executor enforces a barrier so the terminal call
  // runs after every other call. For solo steps `lastIdx === 0` and
  // the behaviour is identical to the legacy path.
  const lastIdx = calls.length - 1;
  const terminal: StepTerminal = classifyTerminal(
    calls[lastIdx]!,
    toolResults[lastIdx]!,
  );

  nextSession = appendBatchedTurns({
    state: nextSession,
    calls,
    results: toolResults,
    reasoning,
    terminal,
    onEvent: deps.onEvent,
  });

  void stepDurationMs; // captured for future cross-call observability hooks
  if (batchOutcome.cancelled) {
    throw new CancelledError("batch cancelled mid-execution");
  }
  return {
    toolCalls: calls,
    toolResults,
    completion,
    prompt,
    nextSession,
    terminal,
    loopSignals: batchOutcome.loopSignals,
    ...(trimmedBatchNotice !== undefined ? { trimmedBatchNotice } : {}),
    ...(waveSplitNotice !== undefined ? { waveSplitNotice } : {}),
  };
}

interface InitialCompletionArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prompt: BuiltPrompt;
  slot: { slotId: number; cacheReused: boolean };
  llmParams: LlmStreamParams;
}

/**
 * Run the first LLM call for a step (stream path when available, unary
 * fallback otherwise) and emit the matching observability events.
 */
async function runInitialCompletion(
  args: InitialCompletionArgs,
): Promise<{ completion: CompletionResult }> {
  const { ctx, deps, prompt, slot, llmParams } = args;
  const startedAt = Date.now();
  const completion = deps.llmCompleteStream
    ? await consumeStream(
        deps.llmCompleteStream(llmParams),
        ctx.stepIndex,
        deps.profile,
        deps.onEvent,
      )
    : await deps.llmComplete(llmParams);
  const durationMs = Date.now() - startedAt;
  deps.onCompletion?.(completion);
  deps.onEvent?.({ type: "llm_completed", completion });
  deps.onEvent?.({
    type: "llm_raw_completion",
    stepIndex: ctx.stepIndex,
    attempt: 1,
    completion,
  });
  deps.metrics?.recordLlmCall({
    sessionId: ctx.session.id,
    promptTokens: completion.timing?.promptTokens ?? prompt.tokens.total,
    completionTokens: completion.timing?.predictedTokens ?? 0,
    durationMs,
    cacheReused: slot.cacheReused,
  });
  return { completion };
}

/**
 * Resolve the reasoning text for a completion, preferring the dedicated
 * `reasoning_content` channel when present and falling back to inline
 * `<think>...</think>` extraction for classic llama-server builds.
 */
function resolveReasoning(
  completion: CompletionResult,
  profile: ModelProfile,
): string {
  const fromChannel =
    typeof completion.reasoningContent === "string"
      ? completion.reasoningContent
      : "";
  if (fromChannel.length > 0) return fromChannel;
  const normalizedContent = normalizeContent(completion, profile);
  const extracted = extractReasoning(
    normalizedContent,
    getReasoningTagOptions(profile),
  );
  return extracted.reasoning;
}

function normalizeContent(
  completion: CompletionResult,
  profile: ModelProfile,
): string {
  return profile.requiresPromptThinkPrefix
    ? `${getReasoningOpenTagPrefix(profile)}${completion.content}`
    : completion.content;
}

type ToolCallBatchParseResult =
  | { ok: true; batch: ToolCallBatch }
  | { ok: false; error: Error };

function isNativeToolsEmptyCompletionHandledByParser(
  deps: Pick<StepDependencies, "toolTransport">,
  reason: string,
  completion: CompletionResult,
): boolean {
  if (deps.toolTransport !== "native_tools" || reason !== "empty") {
    return false;
  }
  // Empty `content` is OK when the model still emitted at least one
  // OpenAI `tool_call` — the parser can recover those.
  if (completion.toolCalls !== undefined && completion.toolCalls.length > 0) {
    return true;
  }
  // Reasoning-only completions (Qwen3.8 with preserve_thinking,
  // DeepSeek-R1 over OpenAI-compatible APIs): the model ends its turn
  // with all text in `reasoning_content`, `content` empty and no
  // tool_calls. The parser salvages these — a GBNF-shaped batch inside
  // the reasoning, or the reasoning itself as a `reply`. Only a
  // completion with NOTHING in any channel routes through ModelError.
  const reasoning =
    typeof completion.reasoningContent === "string"
      ? completion.reasoningContent.trim()
      : "";
  return reasoning.length > 0;
}

/**
 * Is this an empty completion the one-shot repair should get a crack at?
 *
 * On the grammar transports an empty body is not the dead end
 * `detectModelFailure`'s doc assumes. The prompt is not replayed
 * verbatim: the repair path rebuilds it through
 * `buildToolCallRepairPrompt` with a corrective notice and a bounded
 * token cap, which is a materially different request — and the same
 * machinery already recovers every *other* unparseable body (a truncated
 * array, a stray prelude, prose where JSON belongs). Only "the model
 * emitted literally nothing" was singled out to end the turn outright,
 * and that is the single largest failure bucket in production.
 *
 * `native_tools` is deliberately excluded: that transport has its own
 * salvage path (`isNativeToolsEmptyCompletionHandledByParser`), and a
 * native completion with nothing in any channel routes through
 * `ModelError` by design — see `step-executor.test.ts`, "native_tools:
 * routes 'no tool_calls and no content' through ModelError".
 *
 * `truncated` and `no_stop` are excluded too, and for the original
 * reason: the model already spent its budget on this prefix, so a second
 * pass hits the same wall.
 */
function isGrammarEmptyCompletionWorthRepairing(
  deps: Pick<StepDependencies, "toolTransport">,
  reason: string,
): boolean {
  return reason === "empty" && deps.toolTransport !== "native_tools";
}

/**
 * Effective transport for *parsing a response*. Prefers the transport of
 * the provider that actually served the completion (`servedTransport`,
 * stamped by the fallback chain wrapper) over the caller's configured
 * `toolTransport`. They differ on a cross-transport fallover — e.g. a
 * native-tools cloud primary that fell over to a grammar-only local link:
 * the request went out grammar-shaped, so the response must be parsed as
 * grammar, not as OpenAI `tool_calls`. Absent `servedTransport` (the
 * direct, non-wrapped path), the configured transport is authoritative.
 */
function parseDepsFor(
  completion: CompletionResult,
  deps: Pick<StepDependencies, "toolTransport" | "toolCallAdapter">,
): Pick<StepDependencies, "toolTransport" | "toolCallAdapter"> {
  const served = completion.servedTransport;
  if (served === undefined || served === deps.toolTransport) return deps;
  return {
    toolTransport: served,
    // A grammar link needs no adapter; a native link uses the default
    // OpenAI adapter unless the caller carried a custom one for it.
    toolCallAdapter: served === "native_tools" ? deps.toolCallAdapter : null,
  };
}

/**
 * Non-throwing parser wrapper. The step executor uses it to distinguish
 * a malformed first attempt (retryable) from any other error shape.
 * Returns a `ToolCallBatch` that may carry a single call (legacy
 * shape) or N calls in batch-index order.
 */
function tryParseToolCalls(
  completion: CompletionResult,
  profile: ModelProfile,
  deps: Pick<StepDependencies, "toolTransport" | "toolCallAdapter">,
): ToolCallBatchParseResult {
  try {
    if (deps.toolTransport === "native_tools") {
      if (completion.toolCalls && completion.toolCalls.length > 0) {
        const adapter = deps.toolCallAdapter ?? openAiToolCallAdapter;
        const reasoning = resolveReasoning(completion, profile);
        const batch = adapter.toolCallsToBatch(
          completion.toolCalls,
          reasoning,
        );
        if (batch.calls.length === 0) {
          return {
            ok: false,
            error: new Error(
              "native tool_calls array was empty after mapping",
            ),
          };
        }
        return { ok: true, batch };
      }
      // No `tool_calls`, plain `content`. Two recovery paths, in order:
      //
      // 1. The prompt persona instructs models to emit a GBNF-style
      //    `[{tool, args}, ...]` array. Some cloud models (GPT-5 via
      //    aimlapi, GLM-5 via openrouter) follow the persona literally
      //    instead of using the OpenAI `tools` envelope — they put the
      //    JSON array in `content` and leave `tool_calls` empty. Try the
      //    grammar parser first; on success we keep the model's real
      //    intent (multi-call batches, tool args, reasoning preludes)
      //    instead of dumping the JSON literal into `reply.text`.
      // 2. Fallback: wrap the text as a length-1 `reply` batch so the
      //    one-inference-per-step contract holds. This is the companion
      //    of `tool_choice: "auto"` — Qwen-thinking, GLM-5 prelude-only,
      //    any model that thought it could just talk.
      //
      // Empty content is *not* synthesised — that case is intentionally
      // routed through `ModelError` by the outer caller because replaying
      // the same prompt would reproduce the same empty wall.
      const replyText = completion.content;
      if (typeof replyText === "string" && replyText.trim().length > 0) {
        try {
          const grammarBatch = parseToolCalls(
            normalizeContent(completion, profile),
            getReasoningTagOptions(profile),
          );
          if (grammarBatch.calls.length > 0) {
            // The model copied the escaped function names from the OpenAI
            // `tools` schema (e.g. `skill__view`) into a GBNF-style content
            // array. Un-escape each name back to the dotted registry id so
            // `registry.has(...)` resolves — `nameUnescape` is a no-op for
            // names that are already dotted, so this is idempotent.
            const adapter = deps.toolCallAdapter ?? openAiToolCallAdapter;
            const calls = grammarBatch.calls.map((call) => ({
              ...call,
              tool: adapter.nameUnescape(call.tool),
            }));
            return { ok: true, batch: { ...grammarBatch, calls } };
          }
        } catch {
          // Not a GBNF-shaped completion — fall through to the reply wrap.
        }
        const reasoning = resolveReasoning(completion, profile);
        return {
          ok: true,
          batch: {
            kind: "batch",
            calls: [
              {
                tool: "reply",
                args: { text: replyText },
                ...(reasoning.length > 0 ? { reasoning } : {}),
              },
            ],
            ...(reasoning.length > 0 ? { reasoning } : {}),
          },
        };
      }
      // Reasoning-only completion: no tool_calls, empty content, but the
      // think channel carries text. Same two recovery paths as for plain
      // content, applied to the reasoning body: models occasionally emit
      // the GBNF-style call array inside the think block, and a model
      // that reasoned its way to a final answer without ever leaving the
      // think channel still has an answer worth delivering as `reply`.
      const reasoningText =
        typeof completion.reasoningContent === "string"
          ? completion.reasoningContent.trim()
          : "";
      if (reasoningText.length > 0) {
        try {
          const grammarBatch = parseToolCalls(
            reasoningText,
            getReasoningTagOptions(profile),
          );
          if (grammarBatch.calls.length > 0) {
            const adapter = deps.toolCallAdapter ?? openAiToolCallAdapter;
            const calls = grammarBatch.calls.map((call) => ({
              ...call,
              tool: adapter.nameUnescape(call.tool),
            }));
            return { ok: true, batch: { ...grammarBatch, calls } };
          }
        } catch {
          // Not GBNF-shaped — fall through to the reply wrap.
        }
        return {
          ok: true,
          batch: {
            kind: "batch",
            calls: [
              {
                tool: "reply",
                args: { text: reasoningText },
                reasoning: reasoningText,
              },
            ],
            reasoning: reasoningText,
          },
        };
      }
      return {
        ok: false,
        error: new Error(
          "native completion carried neither tool_calls nor content",
        ),
      };
    }
    const batch = parseToolCalls(
      normalizeContent(completion, profile),
      getReasoningTagOptions(profile),
    );
    return { ok: true, batch };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Wrap a completion's non-reasoning prose as a length-1 `reply` batch.
 * Returns `null` when the completion carries nothing but reasoning (a
 * model that degenerated inside its think block has no answer to
 * deliver, so the caller keeps its `GrammarError`).
 */
function replyFallbackBatch(
  completion: CompletionResult,
  profile: ModelProfile,
): ToolCallBatch | null {
  const extracted = extractReasoning(
    normalizeContent(completion, profile),
    getReasoningTagOptions(profile),
  );
  const text = extracted.body.trim();
  if (text.length === 0) return null;
  // Only prose degrades. A body that opens a JSON value means the model
  // did try to emit a call and botched it (or the batch failed
  // validation) — echoing that literal back at the user would be worse
  // than the `GrammarError`.
  if (text.startsWith("{") || text.startsWith("[")) return null;
  const reasoning = resolveReasoning(completion, profile);
  return {
    kind: "batch",
    calls: [
      {
        tool: "reply",
        args: { text },
        ...(reasoning.length > 0 ? { reasoning } : {}),
      },
    ],
    ...(reasoning.length > 0 ? { reasoning } : {}),
  };
}

function buildLlmStreamParams(args: {
  promptText: string;
  deps: Pick<
    StepDependencies,
    "grammar" | "toolTransport" | "toolCallAdapter" | "supportsParallelTools"
  >;
  slotId: number;
  sessionId: string;
  toolDescriptors: readonly ToolDescriptor[];
  signal?: AbortSignal;
}): LlmStreamParams {
  const base: LlmStreamParams = {
    prompt: args.promptText,
    grammar: args.deps.grammar,
    slotId: args.slotId,
    sessionId: args.sessionId,
    ...(args.signal ? { signal: args.signal } : {}),
  };
  if (args.deps.toolTransport !== "native_tools") {
    return base;
  }
  const adapter = args.deps.toolCallAdapter ?? openAiToolCallAdapter;
  return {
    ...base,
    // Keep `grammar` populated (not blanked) even on the native path: the
    // provider fallback chain may hand this request to a grammar-only
    // llama-server link, which needs the GBNF. Native (cloud) providers
    // ignore `grammar` entirely and read `tools`, so carrying both makes
    // the request valid for whichever link actually serves it.
    tools: adapter.descriptorsToTools(args.toolDescriptors),
    // `auto` instead of `required`. Three production-observed reasons:
    //   * Qwen-thinking providers (Alibaba gate) reject `required` outright
    //     with `<400> InvalidParameter: tool_choice does not support being
    //     set to required or object in thinking mode`.
    //   * GLM-5-thinking under `required` dumps the user-facing body into
    //     `reasoning_content` and emits a hollow `reply { text: "<one-line
    //     prelude>" }` just to satisfy the contract — the rest of the
    //     answer is lost from the assistant turn.
    //   * Weak non-thinking models (e.g. deepseek-v4-flash) hallucinate a
    //     `memory.notes.recall {}` (or similar) just to "say something"
    //     when `required` is on, and then loop on the validation error.
    // Under `auto` the model can return plain `content` instead. The
    // step-executor's `tryParseToolCalls` synthesises a `reply` call from
    // that content (see invariant comment there), so the
    // one-inference-per-step contract is preserved.
    toolChoice: "auto",
    // Ask the provider for a single tool call per response unless the
    // executor cap allows more AND the provider reports it can emit
    // parallel calls. With `maxParallelToolCalls=1` this is the
    // provider-compatibility control: some OpenAI-compatible streams
    // (Gemini) lack stable indices for parallel calls, so the setting
    // must reach the wire, not just the executor's batch planner
    // (issue #104).
    parallelToolCalls:
      getConfig().agent.maxParallelToolCalls > 1 &&
      (args.deps.supportsParallelTools ?? true),
  };
}

interface BatchValidation {
  ok: true;
}

interface BatchValidationFailure {
  ok: false;
  error: BatchValidationError;
}

/**
 * Enforce batch invariants:
 *  - Every tool name resolves in the registry (defence in depth — the
 *    grammar already restricts this).
 *  - Terminal `reply` calls carry a non-empty `text` string before they
 *    can close the turn. This catches native-tools calls with `{}` args
 *    and routes them through the repair prompt instead of surfacing the
 *    reply tool's validation error as the assistant's final answer.
 *  - Every call has a known `ResourceClass`.
 *  - When `calls.length > 1`:
 *      * No `terminal` verbs (`reply` / `finish`) inside a batch.
 *      * No `approval_gated` verbs inside a batch.
 *      * `length <= agent.maxParallelToolCalls`.
 *  - Single-call payloads always pass — they preserve the legacy
 *    solo path semantics for any tool, including approval-gated and
 *    terminal verbs.
 *  - Terminal verbs (`reply` / `finish`) are allowed **only as the last
 *    element** of a multi-call batch — the executor enforces a barrier
 *    so the terminal call runs strictly after all non-terminal calls
 *    have completed. Terminals anywhere else (mid-batch, duplicated)
 *    are rejected with a structured per-call reason.
 */
function validateBatch(
  batch: ToolCallBatch,
  registry: ToolRegistry,
): BatchValidation | BatchValidationFailure {
  const calls = batch.calls;
  const perCall: Array<string | null> = new Array(calls.length).fill(null);
  let firstError: string | null = null;

  // Note: missing-from-registry is intentionally NOT validated here.
  // That class of failure is surfaced as `ToolExecutionError` by the
  // step executor (matching the legacy single-call semantics) so the
  // agent loop's failure category is `tool`, not `grammar`. Replaying
  // the same prompt would not change the registry contents.
  void registry;
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const terminalArgsError = validateTerminalArgs(call);
    if (terminalArgsError !== null) {
      perCall[i] = terminalArgsError;
      firstError ??= terminalArgsError;
    }
  }
  if (calls.length > 1) {
    const cap = getConfig().agent.maxParallelToolCalls;
    if (calls.length > cap) {
      const msg = `batch exceeds maxParallelToolCalls (${calls.length} > ${cap})`;
      firstError ??= msg;
    }
    const lastIdx = calls.length - 1;
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      const cls = resourceClassFor(call.tool);
      if (cls === "terminal") {
        // Terminal verbs are allowed only as the LAST call of the
        // batch. Any earlier position (or duplicated terminal) is
        // rejected — the runtime cannot keep firing tools after the
        // turn has been closed.
        if (i !== lastIdx) {
          const msg = `terminal verb '${call.tool}' must be the last call in a batch; got it at index ${i} of ${calls.length}`;
          perCall[i] = msg;
          firstError ??= msg;
        }
      } else if (cls === "approval_gated") {
        const msg = `approval-gated tool '${call.tool}' is forbidden inside a batch; emit it as a single call`;
        perCall[i] = msg;
        firstError ??= msg;
      } else if (!isBatchable(cls)) {
        // Unknown class: reject from any batch.
        const msg = `tool '${call.tool}' has no resource class and cannot be batched`;
        perCall[i] = msg;
        firstError ??= msg;
      }
    }
  }
  if (firstError !== null) {
    return {
      ok: false,
      error: new BatchValidationError(firstError, perCall),
    };
  }
  return { ok: true };
}

function validateTerminalArgs(call: ToolCallPayload): string | null {
  if (call.tool !== "reply") return null;
  const text = call.args.text;
  if (typeof text === "string" && text.trim().length > 0) return null;
  return "reply tool requires args.text to be a non-empty string";
}

/**
 * Classify a `BatchValidationError`: is it "approval-gated calls in a
 * batch and nothing else" (mechanically fixable by trimming) or does
 * the batch also contain a terminal verb / unknown class / oversized
 * payload (which we keep routing through the LLM repair path because
 * trimming the wrong call could lose semantic intent the model is
 * better placed to reconcile)?
 *
 * The classifier is intentionally strict: every non-null per-call entry
 * must mention `approval-gated`. A single `terminal verb` or
 * `no resource class` reason kicks the batch back to repair.
 */
export function isApprovalGatedOnlyFailure(
  error: BatchValidationError,
): boolean {
  const reasons = error.perCall.filter(
    (entry): entry is string => entry !== null,
  );
  if (reasons.length === 0) return false;
  return reasons.every((reason) => reason.includes("approval-gated"));
}

/**
 * Trim a model-emitted batch down to a length-1 array containing the
 * **first** approval-gated call. The dropped calls are surfaced in
 * `dropped` so the caller can render a `### notice` listing them. The
 * "first approval-gated wins" rule respects the model's emit order
 * (writes typically precede the edits that depend on them) without
 * asking the model to re-plan.
 */
export interface BatchTrimResult {
  kept: ToolCallPayload;
  dropped: ToolCallPayload[];
  /** Original batch size before trimming. Always >= 2. */
  originalSize: number;
}

export function trimBatchToFirstApprovalGated(
  batch: ToolCallBatch,
): BatchTrimResult | null {
  const calls = batch.calls;
  const firstApprovalIdx = calls.findIndex(
    (call) => resourceClassFor(call.tool) === "approval_gated",
  );
  if (firstApprovalIdx === -1) return null;
  const kept = calls[firstApprovalIdx]!;
  const dropped = calls.filter((_, idx) => idx !== firstApprovalIdx);
  return { kept, dropped, originalSize: calls.length };
}

/**
 * Render the `### notice` text the model sees on the next step after a
 * trim. The wording is deliberately concrete: it lists the dropped tool
 * names so the model can re-emit them in batch-index order as length-1
 * arrays without re-deriving them from scratch. Mentioning that
 * approval-gated tools must be solo reinforces the rule without
 * triggering the prompt-rule regression we saw earlier (the message
 * lives in the variable tail of the next step's prompt only — never the
 * stable prefix).
 */
export function formatBatchTrimNotice(trim: BatchTrimResult): string {
  const droppedNames = trim.dropped.map((call) => `\`${call.tool}\``).join(", ");
  return [
    `Your previous emission contained ${trim.originalSize} calls including approval-gated tools that must be solo (length-1 array). The runtime auto-executed \`${trim.kept.tool}\` and dropped the rest: ${droppedNames}.`,
    "Retry the dropped calls now, one per step, each as a length-1 array. Do not re-batch them.",
  ].join(" ");
}

/**
 * Render the `### notice` text the model sees on the next step after an
 * oversized pure-read batch was mechanically split into bounded waves.
 * Unlike the trim notice, nothing was dropped — every call ran, just in
 * waves of at most `cap` instead of one all-at-once fan-out. The notice
 * exists so the model understands the array was honoured in full and
 * does not re-emit the calls.
 */
export function formatWaveSplitNotice(
  originalSize: number,
  cap: number,
  waveCount: number,
): string {
  return `Your previous emission contained ${originalSize} reads that exceeded the parallel-call cap of ${cap}. The runtime executed all of them in ${waveCount} bounded wave${waveCount === 1 ? "" : "s"} — nothing was dropped. Do not re-emit those calls.`;
}

/**
 * Preflight for wave splitting (issue #111): does the call's `args`
 * satisfy the tool's registered JSON schema? The schema is taken from
 * the effective descriptor list first (covers dynamic MCP descriptors
 * carrying server-supplied `inputSchema`), falling back to the static
 * default-args map. A tool with no registered schema passes — there is
 * nothing to validate against. An unsupported schema construct fails
 * closed (no wave split) so we never execute a call the runtime cannot
 * vouch for.
 */
export function callArgsSchemaValid(
  call: ToolCallPayload,
  descriptors: readonly ToolDescriptor[],
): boolean {
  const descriptor = descriptors.find((d) => d.name === call.tool);
  const schema =
    descriptor?.argsJsonSchema ?? getDefaultArgsJsonSchema(call.tool);
  if (!schema) return true;
  try {
    return validateJsonSchemaValue(call.args, schema);
  } catch {
    return false;
  }
}

/**
 * Trim a raw completion body to the short preview attached to every
 * `GrammarError` so postmortems can tell grammar misconfiguration apart
 * from truncation or an empty response without digging through streaming
 * logs.
 */
function rawPreview(content: string): string {
  const slice = content.slice(0, 240).replace(/\n/g, "\\n");
  return content.length > 240 ? `${slice}…` : slice;
}

/**
 * Hard cap on `n_predict` for the repair completion. See the comment at
 * the call-site (search `REPAIR_MAX_TOKENS` in this file) for the
 * rationale. Exported so tests can lower it for fast simulation.
 *
 * Bumped from 512 → 1024 after a multi-file rename trace showed
 * legitimate single-call `os.fs.edit` repairs (deep temp path + realistic
 * old/new strings) hitting the 512 ceiling and surfacing as
 * `GrammarError: tool-call body is empty`. 1024 still keeps the
 * anti-runaway guard well under `completionMaxTokens` (8192).
 */
export const REPAIR_MAX_TOKENS = 1024;

function buildToolCallRepairPrompt(
  promptText: string,
  error: Error,
  profile?: ModelProfile,
): string {
  // Strip the trailing reasoning open-tag prefill (e.g. `<think>` for
  // qwen-think, `<|channel>thought\n` for gemma4-think) before
  // appending repair instructions. Without this strip, the repair
  // notice ends up wedged INSIDE the model's open think-block — the
  // model then treats the system instructions as its own prior thought
  // and enters a "wait, let me reconsider" loop that burns the entire
  // `n_predict` budget. Below we re-append the OPEN reasoning prefill
  // at the very end so the model continues in its normal think → emit
  // pattern (bounded by `REPAIR_MAX_TOKENS`).
  //
  // Earlier iterations of this function appended a CLOSED think-block
  // (`<think>\n</think>`) here, attempting a `/no_think` shortcut.
  // Production traces on both qwen-3.5-9b and qwen-3.6-35b-a3b showed
  // the model ignored the close marker and produced markdown-fenced
  // JSON with interleaved prose ("Wait, I need to..."), tripping
  // `GrammarError: tool-call body is empty`. Letting the model think
  // normally in repair — bounded by `REPAIR_MAX_TOKENS` so it cannot
  // run away — restores grammar-clean output.
  const baseText = stripTrailingReasoningPrefill(promptText, profile);
  const lines = [
    baseText.trimEnd(),
    "",
    "### tool-call-repair",
    "The previous completion was rejected before any tool ran.",
    `reason: ${error.message}`,
  ];
  if (error instanceof BatchValidationError) {
    const perCall = error.perCall
      .map((reason, index) => (reason ? `- call[${index}]: ${reason}` : null))
      .filter((line): line is string => line !== null);
    if (perCall.length > 0) {
      lines.push("per-call errors:", ...perCall);
    }
  }
  lines.push(
    "Emit a corrected JSON array only. No prose, no commentary after the array.",
    "Use a length-1 array for `reply`, `finish`, approval-gated tools, or any call that depends on a previous result.",
    "Do not repeat the invalid batch shape.",
    "",
    "### respond",
    "Respond now.",
  );
  const openReasoning = renderOpenReasoningBlock(profile);
  if (openReasoning.length > 0) {
    lines.push(openReasoning);
  }
  return lines.join("\n");
}

function stripTrailingReasoningPrefill(
  promptText: string,
  profile: ModelProfile | undefined,
): string {
  if (!profile || !profile.requiresPromptThinkPrefix) return promptText;
  if (profile.reasoningStyle === "none") return promptText;
  const framing = getReasoningTurnFraming(profile);
  if (framing) {
    // Gemma 4 turn-framing: strip the trailing `<turn|>\n<|turn>model` so the
    // repair instructions land back inside the open system turn.
    let trimmed = promptText.trimEnd();
    const assistantOpen = framing.assistantOpen.trimEnd();
    if (trimmed.endsWith(assistantOpen)) {
      trimmed = trimmed.slice(0, trimmed.length - assistantOpen.length).trimEnd();
    }
    const turnClose = framing.turnClose.trimEnd();
    if (trimmed.endsWith(turnClose)) {
      trimmed = trimmed.slice(0, trimmed.length - turnClose.length).trimEnd();
    }
    return trimmed;
  }
  const openTag = profile.reasoningOpenTag.trimEnd();
  const trimmed = promptText.trimEnd();
  if (trimmed.endsWith(openTag)) {
    return trimmed.slice(0, trimmed.length - openTag.length);
  }
  return promptText;
}

/**
 * Re-append the reasoning open tag (e.g. `<think>`) at the end of the
 * repair prompt for thinking profiles, mirroring the shape of a normal
 * prompt. The model then continues in its standard think → `</think>`
 * → JSON flow, just bounded by `REPAIR_MAX_TOKENS`. For `none` profiles
 * this is a no-op.
 */
function renderOpenReasoningBlock(profile: ModelProfile | undefined): string {
  if (!profile || !profile.requiresPromptThinkPrefix) return "";
  if (profile.reasoningStyle === "none") return "";
  const framing = getReasoningTurnFraming(profile);
  if (framing) {
    // Re-close the system turn and re-open the model turn so the model emits
    // its own `<|channel>thought` block (no prefilled open tag).
    return `${framing.turnClose.trimEnd()}\n${framing.assistantOpen.trimEnd()}`;
  }
  return profile.reasoningOpenTag.trimEnd();
}

/**
 * Normalise any thrown value into an `LlmFailure` so the `step_error`
 * event always carries a canonical `category`. Values that already
 * implement the failure contract short-circuit; raw `LlamaServerError`,
 * `ToolCallParseError`, abort signals and plain errors get wrapped.
 */
function toLlmFailure(err: unknown, ctx: StepContext): LlmFailure {
  if (err instanceof LlmFailure) return err;
  if (ctx.signal.aborted) {
    return new CancelledError(
      err instanceof Error ? err.message : "operation cancelled",
      { cause: err },
    );
  }
  if (err instanceof LlamaServerError) {
    if (err.status === null || err.status >= 500) {
      return new TransportError(err.message, err.status, err.url, { cause: err });
    }
    return new GrammarError(err.message, "", { cause: err });
  }
  // Cloud provider failures — any status — are provider-boundary
  // problems, not tool bugs. A 429 or a dead key must never read as
  // `Turn failed [tool]`. The HTTP client has already spent its bounded
  // retry budget on the transient subset by the time this propagates.
  // The chat message gets the human wording; the raw technical string
  // stays on the cause for logs.
  if (err instanceof OpenAiHttpError) {
    return new TransportError(humanizeOpenAiHttpError(err), err.status, err.url, {
      cause: err,
    });
  }
  if (err instanceof ToolCallParseError) {
    return new GrammarError(err.message, "", { cause: err });
  }
  if (isAbortError(err)) {
    return new CancelledError(
      err instanceof Error ? err.message : "operation cancelled",
      { cause: err },
    );
  }
  const wrapped = err instanceof Error ? err : new Error(String(err));
  const categorised = classifyFailure(wrapped);
  if (categorised === "cancelled") {
    return new CancelledError(wrapped.message, { cause: err });
  }
  // A raw socket failure from a surface that does not wrap its own
  // errors (MCP streamable-http, embeddings, a vendor SDK carrying its
  // own `fetch`) reaches here as a bare `TypeError: fetch failed`. It is
  // a provider-boundary problem, not a tool bug: wrapping it as
  // `ToolExecutionError("unknown", …)` both mislabels the turn for the
  // user and blocks the fallback chain from advancing.
  if (categorised === "transport") {
    return new TransportError(wrapped.message, null, "", { cause: err });
  }
  return new ToolExecutionError("unknown", wrapped.message, { cause: err });
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}

/**
 * Drain the SSE generator, feeding each token delta to the grammar-aware
 * stream parser and relaying its emissions as `StepEvent`s. The generator's
 * terminal return value carries the final `CompletionResult` (timings,
 * cached-tokens, model id), so callers still receive the unary contract.
 *
 * If the generator finishes without emitting a `done` frame (old
 * llama-server builds, truncated network response), we fall back to a
 * synthetic `CompletionResult` populated from the accumulated buffer so
 * the downstream parser still has something to work with.
 */
async function consumeStream(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
  stepIndex: number,
  profile: ModelProfile,
  onEvent?: (event: StepEvent) => void,
): Promise<CompletionResult> {
  const parser = createStreamParser({
    // Pre-opened only when the open tag is prefilled in the prompt. With
    // model-emitted reasoning (Gemma 4 turn-framing) the parser must detect
    // the open tag live in the stream instead.
    preOpenedThink:
      profile.requiresPromptThinkPrefix &&
      !reasoningOpenEmittedByModel(profile),
    ...(profile.reasoningStyle !== "none"
      ? {
          reasoningOpenTag: profile.reasoningOpenTag,
          reasoningCloseTag: profile.reasoningCloseTag,
        }
      : {}),
  });
  let accumulated = "";
  // Channel A (server-side `reasoning_content` SSE deltas: QwQ /
  // DeepSeek-R1 with `--reasoning-format deepseek`) is mutually exclusive
  // with channel B (inline `<think>...</think>` / `<|channel>thought` text
  // that the grammar-aware stream parser splits out client-side). We
  // accumulate them separately so the legacy `/completion` path (where
  // channel A is always empty) still ends up with a populated
  // `reasoningContent` field for traces + `resolveReasoning` callers,
  // without risking double-count when a server happens to emit both.
  let channelAReasoning = "";
  let parserReasoning = "";
  const emitParseEvents = (events: readonly StreamParseEvent[]): void => {
    for (const ev of events) {
      if (ev.kind === "reasoning_delta") {
        parserReasoning += ev.text;
        onEvent?.({ type: "reasoning_delta", stepIndex, text: ev.text });
      } else if (ev.kind === "reply_text_delta") {
        onEvent?.({ type: "assistant_delta", text: ev.text });
      }
    }
  };
  let finalResult: CompletionResult | null = null;
  while (true) {
    const next = await stream.next();
    if (next.done) {
      finalResult = next.value;
      break;
    }
    const chunk = next.value;
    // Channel A: dedicated `reasoning_content` deltas (QwQ, DeepSeek-R1
    // with `--reasoning-format deepseek`). Bypass the grammar parser —
    // these tokens never appear inside `<think>` or JSON, they come on a
    // separate SSE field and are already decoded.
    if (chunk.reasoningDelta && chunk.reasoningDelta.length > 0) {
      channelAReasoning += chunk.reasoningDelta;
      onEvent?.({
        type: "reasoning_delta",
        stepIndex,
        text: chunk.reasoningDelta,
      });
    }
    // Channel B: inline content (may contain `<think>...</think>` +
    // grammar-constrained JSON). The stream parser splits this into
    // reasoning / reply-text deltas for us.
    if (chunk.delta.length > 0) {
      accumulated += chunk.delta;
      emitParseEvents(parser.push(chunk.delta));
    }
    if (chunk.done) {
      // Some servers close the iterator right after the done frame; keep
      // draining until `next.done` so we do not leave the response reader
      // hanging.
    }
  }
  emitParseEvents(parser.end());
  // Prefer server-emitted channel A reasoning when present; otherwise
  // fall back to the parser-derived stream (legacy `/completion`
  // endpoint, which never sets `reasoning_content` server-side).
  const accumulatedReasoning =
    channelAReasoning.length > 0 ? channelAReasoning : parserReasoning;
  if (finalResult === null) {
    finalResult = {
      content: accumulated,
      reasoningContent: accumulatedReasoning,
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 0,
        predictedTokens: 0,
      },
      cacheHitTokens: 0,
      slotId: -1,
      modelId: null,
    };
  } else {
    const patch: Partial<CompletionResult> = {};
    if (finalResult.content.length === 0 && accumulated.length > 0) {
      patch.content = accumulated;
    }
    const existingReasoning =
      typeof finalResult.reasoningContent === "string"
        ? finalResult.reasoningContent
        : "";
    if (existingReasoning.length === 0 && accumulatedReasoning.length > 0) {
      patch.reasoningContent = accumulatedReasoning;
    }
    if (Object.keys(patch).length > 0) {
      finalResult = { ...finalResult, ...patch };
    }
  }
  return finalResult;
}

function getReasoningOpenTagPrefix(profile: ModelProfile): string {
  if (profile.reasoningStyle === "none") return "";
  // When the model emits its own open tag (Gemma 4 turn-framing) the tag is
  // already present in `completion.content` — prepending it would duplicate
  // it, so `normalizeContent` must add nothing.
  if (reasoningOpenEmittedByModel(profile)) return "";
  return profile.reasoningOpenTag;
}

function getReasoningTagOptions(profile: ModelProfile): {
  openTag?: string;
  closeTag?: string;
} {
  if (profile.reasoningStyle === "none") return {};
  return {
    openTag: profile.reasoningOpenTag,
    closeTag: profile.reasoningCloseTag,
  };
}

/**
 * `reply` ends the current macro-turn but keeps the session alive.
 * `finish` ends the whole session. We also accept a legacy
 * `details.final === true` flag from custom tools that want to act as a
 * session terminator without hard-coding the tool name.
 */
function classifyTerminal(
  toolCall: ToolCallPayload,
  toolResult: CompressedToolResult,
): StepTerminal {
  if (toolCall.tool === "reply") return "turn";
  if (toolCall.tool === "finish") return "session";
  const flag = toolResult.details?.final;
  if (flag === true) return "session";
  return null;
}

interface AppendBatchedTurnsParams {
  state: SessionState;
  calls: readonly ToolCallPayload[];
  results: readonly CompressedToolResult[];
  reasoning: string;
  terminal: StepTerminal;
  onEvent?: (event: StepEvent) => void;
}

/**
 * Project the executed step (single or batched) into the conversation
 * transcript. The terminal `reply` verb (`terminal === "turn"`) is
 * collapsed into a single `assistant_reply` turn — no separate
 * tool-call / tool-result pair — so the chat reads naturally. This
 * collapse works both for a solo `[reply]` step and for a batched
 * `[..., reply]` step: in the batched case, every non-terminal call
 * is emitted as the canonical `assistant_tool_call` + `tool_result`
 * pair first, then the tail `reply` collapses into `assistant_reply`
 * at the end (reasoning attaches to the first non-terminal pair, or
 * to the reply itself when there is no non-terminal portion).
 * `terminal === "session"` (`finish`) keeps the legacy tool-call /
 * tool-result projection — the agent loop interprets the `final`
 * flag to close the session without any additional transcript magic.
 *
 * Per-batch char cap: when the combined summary text would exceed
 * `agent.batchToolResultCharCap`, oldest within-batch results get
 * truncated before being appended. This keeps the conversation
 * section bounded under pathological large-batch outputs without
 * losing the call/result pairing.
 */
function appendBatchedTurns(
  params: AppendBatchedTurnsParams,
): SessionState {
  const { state, calls, results, reasoning, terminal, onEvent } = params;

  // `reply` collapses into `assistant_reply` regardless of batch
  // size. For a batched step the terminal is guaranteed to be at the
  // tail (validator invariant), so we emit non-terminal pairs first
  // and then collapse the last call.
  if (terminal === "turn") {
    const terminalIdx = calls.length - 1;
    const terminalCall = calls[terminalIdx]!;
    const terminalResult = results[terminalIdx]!;
    const hasNonTerminal = terminalIdx > 0;
    let next = state;
    if (hasNonTerminal) {
      const nonTerminalSummaries = results
        .slice(0, terminalIdx)
        .map((r) => r.summary);
      const renderedSummaries = capBatchSummaries(
        nonTerminalSummaries,
        getConfig().agent.batchToolResultCharCap,
      );
      for (let i = 0; i < terminalIdx; i += 1) {
        const call = calls[i]!;
        const result = results[i]!;
        const cappedSummary = renderedSummaries[i]!;
        const cappedTruncated = cappedSummary !== result.summary;
        next = recordTurn(
          next,
          assistantToolCallTurn({
            tool: call.tool,
            args: call.args,
            ...(i === 0 && reasoning.length > 0 ? { reasoning } : {}),
          }),
        );
        next = recordTurn(
          next,
          toolResultTurn({
            tool: result.tool,
            status: result.status,
            summary: cappedSummary,
            ...(result.truncated || cappedTruncated ? { truncated: true } : {}),
          }),
        );
      }
    }
    const text =
      typeof terminalCall.args?.text === "string" &&
      terminalCall.args.text.length > 0
        ? (terminalCall.args.text as string)
        : terminalResult.summary;
    onEvent?.({ type: "assistant_reply", text });
    return recordTurn(
      next,
      assistantReplyTurn(
        text,
        // Reasoning attaches to the first non-terminal pair when one
        // exists; otherwise the reply itself owns the <think> block.
        !hasNonTerminal && reasoning.length > 0 ? { reasoning } : undefined,
      ),
    );
  }

  const renderedSummaries = capBatchSummaries(
    results.map((r) => r.summary),
    getConfig().agent.batchToolResultCharCap,
  );

  let next = state;
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const result = results[i]!;
    const cappedSummary = renderedSummaries[i]!;
    const cappedTruncated = cappedSummary !== result.summary;
    next = recordTurn(
      next,
      assistantToolCallTurn({
        tool: call.tool,
        args: call.args,
        ...(i === 0 && reasoning.length > 0 ? { reasoning } : {}),
      }),
    );
    next = recordTurn(
      next,
      toolResultTurn({
        tool: result.tool,
        status: result.status,
        summary: cappedSummary,
        ...(result.truncated || cappedTruncated ? { truncated: true } : {}),
      }),
    );
  }
  return next;
}

/**
 * Apply a soft per-batch char cap across all summaries in one step.
 * Truncates from the start of the list (oldest within-batch results
 * lose detail first) so the freshest results — typically the ones the
 * model will reason about next — keep their full text.
 */
function capBatchSummaries(
  summaries: readonly string[],
  capChars: number,
): string[] {
  const total = summaries.reduce((acc, s) => acc + s.length, 0);
  if (total <= capChars) return summaries.slice();
  const out = summaries.slice();
  let overshoot = total - capChars;
  for (let i = 0; i < out.length && overshoot > 0; i += 1) {
    const s = out[i]!;
    if (s.length === 0) continue;
    const drop = Math.min(s.length, overshoot);
    const keep = s.length - drop;
    if (keep <= 16) {
      out[i] = "[truncated]";
      overshoot -= s.length - "[truncated]".length;
    } else {
      out[i] = `${s.slice(0, keep)} … [truncated]`;
      overshoot -= drop - " … [truncated]".length;
    }
  }
  return out;
}

/**
 * Inspect well-known tool-result fields and fold them into the session
 * state. Tools communicate state updates through `details.skillLoaded`
 * (`skill.view`), `details.toolLoaded` (`tool.view`), and
 * `details.worldSnapshot` (for browser actions) so the step executor
 * stays generic and tools remain pure.
 */
function applyStateEffects(
  session: SessionState,
  result: CompressedToolResult,
): SessionState {
  let next = session;
  const details = result.details;
  if (details && typeof details === "object") {
    const toolLoaded = (details as Record<string, unknown>).toolLoaded;
    if (
      toolLoaded &&
      typeof toolLoaded === "object" &&
      typeof (toolLoaded as { name?: unknown }).name === "string" &&
      typeof (toolLoaded as { summary?: unknown }).summary === "string" &&
      typeof (toolLoaded as { argsSchema?: unknown }).argsSchema ===
        "string" &&
      ((toolLoaded as { source?: unknown }).source === "explicit" ||
        (toolLoaded as { source?: unknown }).source === "auto")
    ) {
      const t = toolLoaded as {
        name: string;
        summary: string;
        argsSchema: string;
        examples?: string[];
        source: "explicit" | "auto";
      };
      next = recordLoadedTool(
        next,
        {
          name: t.name,
          summary: t.summary,
          argsSchema: t.argsSchema,
          ...(t.examples !== undefined && t.examples.length > 0
            ? { examples: t.examples }
            : {}),
          source: t.source,
        },
        getConfig().agent.loadedToolsCap,
      );
    }
    const loaded = (details as Record<string, unknown>).skillLoaded;
    if (
      loaded &&
      typeof loaded === "object" &&
      typeof (loaded as { name?: unknown }).name === "string" &&
      typeof (loaded as { version?: unknown }).version === "string" &&
      typeof (loaded as { body?: unknown }).body === "string"
    ) {
      const entry = loaded as { name: string; version: string; body: string };
      next = recordLoadedSkill(next, {
        name: entry.name,
        version: entry.version,
        body: entry.body,
        loadedAt: Date.now(),
      });
    }
    const snapshot = (details as Record<string, unknown>).worldSnapshot;
    if (
      snapshot &&
      typeof snapshot === "object" &&
      typeof (snapshot as { digest?: unknown }).digest === "string" &&
      typeof (snapshot as { text?: unknown }).text === "string"
    ) {
      const entry = snapshot as { digest: string; text: string; kind?: string };
      next = recordWorldSnapshot(next, {
        kind: entry.kind === "browser" ? "browser" : "browser",
        digest: entry.digest,
        text: entry.text,
        capturedAt: Date.now(),
      });
    }
  }
  return next;
}
