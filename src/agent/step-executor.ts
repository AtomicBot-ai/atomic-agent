import {
  extractReasoning,
  parseToolCall,
  ToolCallParseError,
} from "../llm/grammar/tool-call-grammar.js";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
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
import type { AgentMetrics } from "../telemetry/agent-metrics.js";
import type { StructuredLogger } from "../telemetry/structured-logger.js";
import type { StepEvent } from "./step-events.js";
export type { PromptCapturedTokens, StepEvent } from "./step-events.js";

export interface LlmStreamParams {
  prompt: string;
  grammar: string;
  slotId: number;
  sessionId: string;
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

export interface StepOutcome {
  toolCall: ToolCallPayload;
  toolResult: CompressedToolResult;
  completion: CompletionResult;
  prompt: BuiltPrompt;
  nextSession: SessionState;
  terminal: StepTerminal;
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

  let parsed = tryParseToolCall(completion, deps.profile);
  if (!parsed.ok) {
    // One-shot parser retry: grammar outputs can be truncated or
    // malformed for transient reasons (stop-sequence race, model hiccup).
    // Retry via the unary LLM path — the streaming path has already
    // flushed partial deltas, so replaying through it would double-emit.
    deps.onEvent?.({
      type: "parse_retry",
      stepIndex: ctx.stepIndex,
      attempt: 1,
      reason: parsed.error.message,
    });
    deps.logger?.warn("tool-call parse failed, retrying once", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      reason: parsed.error.message,
    });

    const retryStartedAt = Date.now();
    completion = await deps.llmComplete(llmParams);
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

    parsed = tryParseToolCall(completion, deps.profile);
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
  const toolCall = parsed.toolCall;
  if (!deps.registry.has(toolCall.tool)) {
    throw new ToolExecutionError(
      toolCall.tool,
      `tool not registered in this agent: ${toolCall.tool}`,
    );
  }
  deps.onEvent?.({ type: "tool_call_parsed", call: toolCall });

  const toolStartedAt = Date.now();
  let toolResult: CompressedToolResult;
  try {
    toolResult = await deps.registry.invoke(toolCall.tool, toolCall.args, {
      workingDir: ctx.session.workingDir,
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      signal: ctx.signal,
    });
  } catch (err) {
    // Abort signal trumps error handling: propagate so the loop can
    // close the turn cleanly with `reason: cancelled`.
    if (ctx.signal.aborted) throw err;
    const cause = err instanceof Error ? err : new Error(String(err));
    deps.logger?.warn("tool execution failed", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      tool: toolCall.tool,
      error: cause.message,
    });
    toolResult = compressToolResult({
      tool: toolCall.tool,
      status: "error",
      output: cause.message,
      details: { errorName: cause.name },
    });
  }
  const toolDurationMs = Date.now() - toolStartedAt;
  deps.onEvent?.({ type: "tool_call_executed", result: toolResult });
  deps.metrics?.recordTool({
    sessionId: ctx.session.id,
    tool: toolResult.tool,
    status: toolResult.status,
    durationMs: toolDurationMs,
  });
  deps.logger?.info("tool executed", {
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    tool: toolResult.tool,
    status: toolResult.status,
    durationMs: toolDurationMs,
  });

  const terminal = classifyTerminal(toolCall, toolResult);

  let nextSession = recordLatestResult(
    {
      ...ctx.session,
      stepCount: ctx.session.stepCount + 1,
    },
    {
      tool: toolResult.tool,
      status: toolResult.status,
      summary: toolResult.summary,
      ...(toolResult.details !== undefined ? { details: toolResult.details } : {}),
    },
  );
  nextSession = applyStateEffects(nextSession, toolResult);
  nextSession = appendConversationTurns({
    state: nextSession,
    toolCall,
    toolResult,
    reasoning,
    terminal,
    onEvent: deps.onEvent,
  });

  return { toolCall, toolResult, completion, prompt, nextSession, terminal };
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

type ToolCallParseResult =
  | { ok: true; toolCall: ToolCallPayload }
  | { ok: false; error: Error };

/**
 * Non-throwing parser wrapper. The step executor uses it to distinguish
 * a malformed first attempt (retryable) from any other error shape.
 */
function tryParseToolCall(
  completion: CompletionResult,
  profile: ModelProfile,
): ToolCallParseResult {
  try {
    const toolCall = parseToolCall(
      normalizeContent(completion, profile),
      getReasoningTagOptions(profile),
    );
    return { ok: true, toolCall };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
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

interface AppendTurnsParams {
  state: SessionState;
  toolCall: ToolCallPayload;
  toolResult: CompressedToolResult;
  reasoning: string;
  terminal: StepTerminal;
  onEvent?: (event: StepEvent) => void;
}

/**
 * Project the executed step into the conversation transcript. `reply` is
 * collapsed into a single `assistant_reply` turn (no separate tool-call /
 * tool-result pair) so the chat reads naturally. Everything else gets the
 * canonical pair.
 */
function appendConversationTurns(params: AppendTurnsParams): SessionState {
  const { state, toolCall, toolResult, reasoning, terminal, onEvent } = params;

  if (terminal === "turn") {
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

  let next = recordTurn(
    state,
    assistantToolCallTurn({
      tool: toolCall.tool,
      args: toolCall.args,
      ...(reasoning.length > 0 ? { reasoning } : {}),
    }),
  );
  next = recordTurn(
    next,
    toolResultTurn({
      tool: toolResult.tool,
      status: toolResult.status,
      summary: toolResult.summary,
      ...(toolResult.truncated ? { truncated: true } : {}),
    }),
  );
  return next;
}

/**
 * Inspect well-known tool-result fields and fold them into the session
 * state. Tools communicate state updates through `details.skillLoaded`
 * (for `skill.view`) and `details.worldSnapshot` (for browser actions)
 * so the step executor stays generic and tools remain pure.
 */
function applyStateEffects(
  session: SessionState,
  result: CompressedToolResult,
): SessionState {
  let next = session;
  const details = result.details;
  if (details && typeof details === "object") {
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
