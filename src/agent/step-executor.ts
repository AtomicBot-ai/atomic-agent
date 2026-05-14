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
} from "./batch-executor.js";
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
  ToolExecutionError,
  TransportError,
  classifyFailure,
  detectModelFailure,
} from "../llm/index.js";
import { getConfig } from "../config/index.js";
import {
  getToolDescriptorByName,
  isRareToolName,
} from "../prompt/tool-descriptors.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuiltPrompt } from "../prompt/build-prompt.js";
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
import type { ModelProfile } from "../llm/model-profile.js";
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
}

export type LlmCompleteStream = (
  params: LlmStreamParams,
) => AsyncGenerator<StreamChunk, CompletionResult, void>;

export interface StepDependencies {
  registry: ToolRegistry;
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
   * Invoked after every LLM completion (initial call and one-shot parse
   * retry alike). Used by the agent loop to feed the served `modelId`
   * into the profile manager so mid-turn model swaps can be detected.
   */
  onCompletion?: (completion: CompletionResult) => void;
  onEvent?: (event: StepEvent) => void;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
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
 * `terminal` is only set when the model emitted exactly one terminal
 * verb (`reply` or `finish`). Terminal verbs are forbidden inside
 * multi-call batches, so a `terminal !== null` outcome always implies
 * `toolCalls.length === 1`.
 */
export interface StepOutcome {
  toolCalls: ToolCallPayload[];
  toolResults: CompressedToolResult[];
  completion: CompletionResult;
  prompt: BuiltPrompt;
  nextSession: SessionState;
  terminal: StepTerminal;
}

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
  const slot = deps.slotManager.acquire(ctx.session.id, prompt.stablePrefix);
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

  const llmParams: LlmStreamParams = {
    prompt: prompt.text,
    grammar: deps.grammar,
    slotId: slot.slotId,
    sessionId: ctx.session.id,
  };

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
  // fundamentally broken completion (truncated / empty / no_stop). A
  // parser retry on the same prompt would repeat the same wall, so we
  // short-circuit into `ModelError` which the agent loop surfaces
  // without replaying the step.
  const initialModelFailure = detectModelFailure(completion);
  if (initialModelFailure !== null) {
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

  let parsed = tryParseToolCalls(completion, deps.profile);
  if (parsed.ok) {
    const validation = validateBatch(parsed.batch, deps.registry);
    if (!validation.ok) {
      parsed = { ok: false, error: validation.error };
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
      // Tight cap on the repair completion. A correct one-shot tool-call
      // (worst-case `os.fs.edit` with a 200-char `oldString` + replacement)
      // fits comfortably under 512 tokens. Without this cap, reasoning
      // models (qwen-3.5-9b in particular) routinely fall into a
      // self-deliberation loop after a `BatchValidationError` and burn
      // the full `completionMaxTokens` (8192) generating dozens of
      // duplicated JSON candidates wrapped in "wait, let me reconsider"
      // prose — that's 3-5 minutes of wall time per repair on a 9B
      // model and the slot stays busy the entire time, cascading into
      // 0-step timeouts on subsequent eval cases. With the cap, an
      // unrecoverable repair fails in ~7s instead and the slot is freed
      // immediately; a recoverable one fits in 512 tokens by design.
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
    if (retryModelFailure !== null) {
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

    parsed = tryParseToolCalls(completion, deps.profile);
    if (parsed.ok) {
      const validation = validateBatch(parsed.batch, deps.registry);
      if (!validation.ok) {
        parsed = { ok: false, error: validation.error };
      }
    }
    if (!parsed.ok) {
      deps.logger?.warn("tool-call parse failed after retry", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        rawLength: completion.content.length,
        raw: completion.content,
      });
      throw new GrammarError(
        parsed.error.message,
        rawPreview(completion.content),
        { cause: parsed.error },
      );
    }
  }
  const batch = parsed.batch;
  const calls = batch.calls;
  const isSolo = calls.length === 1;
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
  const batchOutcome = await executeBatch(inputs, deps.registry, {
    workingDir: ctx.session.workingDir,
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    signal: ctx.signal,
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

  // Terminal classification only meaningful for solo calls — terminal
  // verbs are validated out of multi-call batches.
  const terminal: StepTerminal = isSolo
    ? classifyTerminal(calls[0]!, toolResults[0]!)
    : null;

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

/**
 * Non-throwing parser wrapper. The step executor uses it to distinguish
 * a malformed first attempt (retryable) from any other error shape.
 * Returns a `ToolCallBatch` that may carry a single call (legacy
 * shape) or N calls in batch-index order.
 */
function tryParseToolCalls(
  completion: CompletionResult,
  profile: ModelProfile,
): ToolCallBatchParseResult {
  try {
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
 *  - Every call has a known `ResourceClass`.
 *  - When `calls.length > 1`:
 *      * No `terminal` verbs (`reply` / `finish`) inside a batch.
 *      * No `approval_gated` verbs inside a batch.
 *      * `length <= agent.maxParallelToolCalls`.
 *  - Single-call payloads always pass — they preserve the legacy
 *    solo path semantics for any tool, including approval-gated and
 *    terminal verbs.
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
  if (calls.length > 1) {
    const cap = getConfig().agent.maxParallelToolCalls;
    if (calls.length > cap) {
      const msg = `batch exceeds maxParallelToolCalls (${calls.length} > ${cap})`;
      firstError ??= msg;
    }
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      const cls = resourceClassFor(call.tool);
      if (cls === "terminal") {
        const msg = `terminal verb '${call.tool}' is forbidden inside a batch; emit it as a single call`;
        perCall[i] = msg;
        firstError ??= msg;
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
 */
export const REPAIR_MAX_TOKENS = 512;

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
  // `n_predict` budget. Below we re-open AND immediately close the
  // think-block at the very end, signalling "no thinking, emit JSON
  // straight away" (the standard `/no_think` trick for qwen models).
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
    "Emit a corrected JSON array only. No prose, no thinking, no commentary.",
    "Use a length-1 array for `reply`, `finish`, approval-gated tools, or any call that depends on a previous result.",
    "Do not repeat the invalid batch shape.",
    "",
    "### respond",
    "Respond now.",
  );
  // For reasoning profiles, append a closed (empty) think-block so the
  // model continues straight into the JSON array instead of opening a
  // fresh `<think>` chain. For `none` profiles this is a no-op.
  const closedReasoning = renderClosedReasoningBlock(profile);
  if (closedReasoning.length > 0) {
    lines.push(closedReasoning);
  }
  return lines.join("\n");
}

function stripTrailingReasoningPrefill(
  promptText: string,
  profile: ModelProfile | undefined,
): string {
  if (!profile || !profile.requiresPromptThinkPrefix) return promptText;
  if (profile.reasoningStyle === "none") return promptText;
  const openTag = profile.reasoningOpenTag.trimEnd();
  const trimmed = promptText.trimEnd();
  if (trimmed.endsWith(openTag)) {
    return trimmed.slice(0, trimmed.length - openTag.length);
  }
  return promptText;
}

function renderClosedReasoningBlock(profile: ModelProfile | undefined): string {
  if (!profile || !profile.requiresPromptThinkPrefix) return "";
  if (profile.reasoningStyle === "none") return "";
  return `${profile.reasoningOpenTag.trimEnd()}\n${profile.reasoningCloseTag.trimEnd()}`;
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
    preOpenedThink: profile.requiresPromptThinkPrefix,
    ...(profile.reasoningStyle !== "none"
      ? {
          reasoningOpenTag: profile.reasoningOpenTag,
          reasoningCloseTag: profile.reasoningCloseTag,
        }
      : {}),
  });
  let accumulated = "";
  let accumulatedReasoning = "";
  const emitParseEvents = (events: readonly StreamParseEvent[]): void => {
    if (!onEvent) return;
    for (const ev of events) {
      if (ev.kind === "reasoning_delta") {
        onEvent({ type: "reasoning_delta", stepIndex, text: ev.text });
      } else if (ev.kind === "reply_text_delta") {
        onEvent({ type: "assistant_delta", text: ev.text });
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
      accumulatedReasoning += chunk.reasoningDelta;
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
  return profile.reasoningStyle === "none" ? "" : profile.reasoningOpenTag;
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
 * transcript. The terminal `reply` verb is always solo (validated out
 * of multi-call batches) and is collapsed into a single
 * `assistant_reply` turn — no separate tool-call / tool-result pair —
 * so the chat reads naturally. For everything else (single non-
 * terminal call OR a multi-call batch), the canonical
 * `assistant_tool_call` + `tool_result` pairs are appended in
 * batch-index order. Reasoning is attached once on the first
 * `assistant_tool_call` of the batch (a single inference produces a
 * single `<think>` block regardless of `kind`).
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

  if (terminal === "turn") {
    const toolCall = calls[0]!;
    const toolResult = results[0]!;
    const text =
      typeof toolCall.args?.text === "string" && toolCall.args.text.length > 0
        ? (toolCall.args.text as string)
        : toolResult.summary;
    onEvent?.({ type: "assistant_reply", text });
    return recordTurn(
      state,
      assistantReplyTurn(
        text,
        reasoning.length > 0 ? { reasoning } : undefined,
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
