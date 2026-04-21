import {
  extractReasoning,
  parseToolCall,
} from "../llm/grammar/tool-call-grammar.js";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
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
import type { CompletionResult } from "../llm/llama-server-client.js";
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
import type { SlotManager } from "../llm/slot-manager.js";
import type { AgentMetrics } from "../telemetry/agent-metrics.js";
import type { StructuredLogger } from "../telemetry/structured-logger.js";

export interface StepDependencies {
  registry: ToolRegistry;
  slotManager: SlotManager;
  llmComplete: (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
  }) => Promise<CompletionResult>;
  grammar: string;
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
}

export type StepEvent =
  | { type: "prompt_built"; prompt: BuiltPrompt; slotId: number }
  | { type: "llm_completed"; completion: CompletionResult }
  /**
   * Non-fatal: reasoning model emitted `<think>...</think>` blocks before
   * the tool-call JSON. Surfaced so UIs can display the model's thought
   * process without polluting the feed. Always arrives *before*
   * `tool_call_parsed` and *before* any `step_error` from the parser.
   */
  | { type: "reasoning"; stepIndex: number; text: string }
  | { type: "tool_call_parsed"; call: ToolCallPayload }
  | { type: "tool_call_executed"; result: CompressedToolResult }
  | { type: "assistant_reply"; text: string }
  | { type: "step_error"; error: Error };

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
 */
export async function executeStep(
  ctx: StepContext,
  deps: StepDependencies,
): Promise<StepOutcome> {
  const prompt = buildPrompt({
    session: ctx.session,
    toolDescriptors: ctx.toolDescriptors,
    capabilities: ctx.capabilities,
    skillCatalog: ctx.skillCatalog,
  });
  const slot = deps.slotManager.acquire(ctx.session.id, prompt.stablePrefix);
  deps.onEvent?.({ type: "prompt_built", prompt, slotId: slot.slotId });
  deps.logger?.debug("prompt built", {
    sessionId: ctx.session.id,
    slotId: slot.slotId,
    cacheReused: slot.cacheReused,
    promptTokens: prompt.tokens.total,
  });

  const llmStartedAt = Date.now();
  const completion = await deps.llmComplete({
    prompt: prompt.text,
    grammar: deps.grammar,
    slotId: slot.slotId,
    sessionId: ctx.session.id,
  });
  const llmDurationMs = Date.now() - llmStartedAt;
  deps.onEvent?.({ type: "llm_completed", completion });
  deps.metrics?.recordLlmCall({
    sessionId: ctx.session.id,
    promptTokens: completion.timing?.promptTokens ?? prompt.tokens.total,
    completionTokens: completion.timing?.predictedTokens ?? 0,
    durationMs: llmDurationMs,
    cacheReused: slot.cacheReused,
  });

  const { reasoning } = extractReasoning(completion.content);
  if (reasoning.length > 0) {
    deps.onEvent?.({
      type: "reasoning",
      stepIndex: ctx.stepIndex,
      text: reasoning,
    });
  }

  let toolCall: ToolCallPayload;
  try {
    toolCall = parseToolCall(completion.content);
  } catch (err) {
    const inner = err instanceof Error ? err : new Error(String(err));
    // Surface the raw llama-server output so operators can tell apart
    // grammar misconfiguration (content="{}"), truncation, or an empty
    // response from a genuine logic bug.
    const preview = completion.content.slice(0, 240).replace(/\n/g, "\\n");
    const error = new Error(
      `${inner.message} (raw: "${preview}${completion.content.length > 240 ? "…" : ""}")`,
    );
    error.stack = inner.stack;
    deps.logger?.warn("tool-call parse failed", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      rawLength: completion.content.length,
      raw: completion.content,
    });
    deps.onEvent?.({ type: "step_error", error });
    throw error;
  }
  if (!deps.registry.has(toolCall.tool)) {
    const error = new Error(`tool not registered in this agent: ${toolCall.tool}`);
    deps.onEvent?.({ type: "step_error", error });
    throw error;
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
    return recordTurn(state, assistantReplyTurn(text));
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
