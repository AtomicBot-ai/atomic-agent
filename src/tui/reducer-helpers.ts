import type { MetricSample } from "../tracing/metrics-collector.js";
import type { LogRecord } from "../tracing/structured-logger.js";
import type {
  ChatMessage,
  FeedEntry,
  ReasoningEntry,
  RunHistoryEntry,
  RunOutcome,
  StreamingToolCall,
  ToolCardEntry,
  TuiState,
} from "./tui-state.js";

/** Push `next` onto `list`, dropping the oldest entry if the ring is full. */
export function pushRing<T>(list: readonly T[], next: T, cap: number): T[] {
  if (list.length < cap) return [...list, next];
  return [...list.slice(list.length - cap + 1), next];
}

export function appendFeed(
  state: TuiState,
  entry: Omit<FeedEntry, "id" | "timestamp">,
): TuiState {
  const timestamp = Date.now();
  const id = `${timestamp}-${state.feed.length}`;
  const next: FeedEntry = { id, timestamp, ...entry };
  return { ...state, feed: pushRing(state.feed, next, state.ringBufferSize) };
}

export function appendReasoning(
  state: TuiState,
  entry: Omit<ReasoningEntry, "id" | "timestamp">,
): TuiState {
  const timestamp = Date.now();
  const id = `${timestamp}-${state.reasoning.length}`;
  const next: ReasoningEntry = { id, timestamp, ...entry };
  return {
    ...state,
    reasoning: pushRing(state.reasoning, next, state.ringBufferSize),
  };
}

/**
 * Append an incremental reasoning chunk streamed from the model. When a
 * reasoning entry for the same `stepIndex` already exists at the tail, the
 * delta is concatenated onto its text so the TUI renders a single growing
 * block. Otherwise a fresh entry is pushed. The authoritative
 * `appendReasoning` (final `<think>` block) later replaces the text in-
 * place, guaranteeing the final rendering matches the canonical value.
 */
export function appendReasoningDelta(
  state: TuiState,
  params: { stepIndex: number; text: string },
): TuiState {
  if (params.text.length === 0) return state;
  const last = state.reasoning.at(-1);
  if (last && last.stepIndex === params.stepIndex) {
    const updated: ReasoningEntry = { ...last, text: last.text + params.text };
    const reasoning = [...state.reasoning.slice(0, -1), updated];
    return { ...state, reasoning };
  }
  const timestamp = Date.now();
  const id = `${timestamp}-${state.reasoning.length}`;
  const entry: ReasoningEntry = {
    id,
    timestamp,
    stepIndex: params.stepIndex,
    text: params.text,
  };
  return {
    ...state,
    reasoning: pushRing(state.reasoning, entry, state.ringBufferSize),
  };
}

/**
 * Replace (or append) the reasoning entry for a given step with the final
 * authoritative text from `extractReasoning`. Used by the non-delta
 * `reasoning` step event so streamed-in text is superseded by the
 * canonical post-parse value — avoids rendering drift when the stream
 * parser and the final parser disagree on exact whitespace.
 */
export function upsertReasoning(
  state: TuiState,
  params: { stepIndex: number; text: string },
): TuiState {
  const idx = state.reasoning.findIndex(
    (entry) => entry.stepIndex === params.stepIndex,
  );
  if (idx !== -1) {
    const existing = state.reasoning[idx]!;
    const updated: ReasoningEntry = { ...existing, text: params.text };
    const reasoning = [
      ...state.reasoning.slice(0, idx),
      updated,
      ...state.reasoning.slice(idx + 1),
    ];
    return { ...state, reasoning };
  }
  return appendReasoning(state, {
    stepIndex: params.stepIndex,
    text: params.text,
  });
}

export function appendLog(state: TuiState, record: LogRecord): TuiState {
  return { ...state, logs: pushRing(state.logs, record, state.ringBufferSize) };
}

export function appendChatMessage(
  state: TuiState,
  entry: Omit<ChatMessage, "id" | "timestamp">,
): TuiState {
  const timestamp = Date.now();
  const id = `${timestamp}-${state.messages.length}`;
  const next: ChatMessage = { id, timestamp, ...entry };
  return {
    ...state,
    messages: pushRing(state.messages, next, state.ringBufferSize),
  };
}

/** Append a user chat message and mirror it into `inputHistory`. */
export function appendUserMessage(state: TuiState, text: string): TuiState {
  const withMessage = appendChatMessage(state, { role: "user", text });
  const history = pushRing(state.inputHistory, text, state.ringBufferSize);
  return {
    ...withMessage,
    inputHistory: history,
    inputHistoryCursor: null,
  };
}

export function lastUserMessage(state: TuiState): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const msg = state.messages[i];
    if (msg?.role === "user") return msg.text;
  }
  return "";
}

/**
 * Reset per-turn UI state when the user submits a new chat message. We
 * intentionally keep cumulative `runHistory`, `logs` and `inputHistory`,
 * but wipe the feed, current step counter, approval banner, last-run
 * status line and live streaming state so the screen is clean for the
 * new turn. Per-turn metrics (`promptTokensLast`, `stepDurationMsLast`,
 * …) are reset too; cumulative counters (`totalTokens`, `kvCacheHits`)
 * persist.
 */
export function startNewRun(state: TuiState): TuiState {
  const now = Date.now();
  return {
    ...state,
    status: "running",
    currentStep: 0,
    stepStartedAt: null,
    runStartedAt: now,
    feed: [],
    reasoning: [],
    currentTurnToolSteps: 0,
    streamingAssistantText: null,
    streamingToolCalls: [],
    streamingToolCards: [],
    pendingApproval: null,
    metrics: {
      ...state.metrics,
      promptTokensLast: null,
      completionTokensLast: null,
      llmDurationMsLast: null,
      stepDurationMsLast: null,
    },
    lastRunStatus: null,
    inputValue: "",
    inputHistoryCursor: null,
    slashPaletteOpen: false,
    slashQuery: "",
    slashPaletteCursor: 0,
    aborting: false,
  };
}

export function finishTurn(
  state: TuiState,
  reason: string,
  stepCount: number,
): TuiState {
  const lastRunStatus = `turn ${reason}`;
  const outcome: RunOutcome =
    reason === "cancelled" || reason === "failed"
      ? reason === "failed"
        ? "failed"
        : "cancelled"
      : "completed";
  return withRunHistoryEntry(state, {
    outcome,
    reason,
    stepCount,
    lastRunStatus,
  });
}

export function finishRun(
  state: TuiState,
  params: { outcome: RunOutcome; reason: string; lastRunStatus: string },
): TuiState {
  return withRunHistoryEntry(state, {
    outcome: params.outcome,
    reason: params.reason,
    stepCount: state.currentStep + 1,
    lastRunStatus: params.lastRunStatus,
  });
}

function withRunHistoryEntry(
  state: TuiState,
  params: {
    outcome: RunOutcome;
    reason: string;
    stepCount: number;
    lastRunStatus: string;
  },
): TuiState {
  const entry: RunHistoryEntry = {
    message: lastUserMessage(state),
    outcome: params.outcome,
    reason: params.reason,
    stepCount: params.stepCount,
    durationMs: state.runStartedAt ? Date.now() - state.runStartedAt : 0,
    finishedAt: Date.now(),
  };
  return {
    ...state,
    status: "idle",
    runStartedAt: null,
    stepStartedAt: null,
    aborting: false,
    lastRunStatus: params.lastRunStatus,
    runHistory: pushRing(state.runHistory, entry, state.ringBufferSize),
    currentTurnToolSteps: 0,
  };
}

export function applyMetric(state: TuiState, sample: MetricSample): TuiState {
  switch (sample.name) {
    case "llm.prompt_tokens":
      return {
        ...state,
        metrics: {
          ...state.metrics,
          promptTokensLast: sample.value,
          totalTokens: state.metrics.totalTokens + sample.value,
        },
      };
    case "llm.completion_tokens":
      return {
        ...state,
        metrics: {
          ...state.metrics,
          completionTokensLast: sample.value,
          totalTokens: state.metrics.totalTokens + sample.value,
        },
      };
    case "llm.duration_ms":
      return {
        ...state,
        metrics: { ...state.metrics, llmDurationMsLast: sample.value },
      };
    case "llm.cache_reused": {
      const hit = sample.value === 1;
      return {
        ...state,
        metrics: {
          ...state.metrics,
          kvCacheHits: state.metrics.kvCacheHits + (hit ? 1 : 0),
          kvCacheMisses: state.metrics.kvCacheMisses + (hit ? 0 : 1),
        },
      };
    }
    default:
      return state;
  }
}

export function beginStreamingToolCall(
  state: TuiState,
  call: StreamingToolCall,
): TuiState {
  return {
    ...state,
    streamingToolCalls: [...state.streamingToolCalls, call],
  };
}

export function finalizeStreamingToolCall(
  state: TuiState,
  params: {
    tool: string;
    status: "ok" | "error";
    summary: string;
    truncated: boolean;
    details?: Record<string, unknown>;
  },
): { state: TuiState; card: ToolCardEntry | null } {
  const idx = state.streamingToolCalls.findIndex(
    (c) => c.tool === params.tool,
  );
  if (idx === -1) return { state, card: null };
  const call = state.streamingToolCalls[idx];
  if (!call) return { state, card: null };
  const finishedAt = Date.now();
  const card: ToolCardEntry = {
    id: call.id,
    stepIndex: call.stepIndex,
    tool: call.tool,
    args: call.args,
    status: params.status,
    summary: params.summary,
    truncated: params.truncated,
    ...(params.details !== undefined ? { details: params.details } : {}),
    startedAt: call.startedAt,
    finishedAt,
  };
  const remaining = [
    ...state.streamingToolCalls.slice(0, idx),
    ...state.streamingToolCalls.slice(idx + 1),
  ];
  return {
    state: {
      ...state,
      streamingToolCalls: remaining,
      streamingToolCards: [...state.streamingToolCards, card],
    },
    card,
  };
}
