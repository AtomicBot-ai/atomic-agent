/**
 * Turns the trace bus's events into OpenTelemetry spans, named and
 * attributed after the GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/; still marked
 * Development upstream, so names may move):
 *
 *  - one trace per turn, rooted at an `invoke_agent` span
 *    (`turn_started` .. `turn_finished`);
 *  - a `chat` span per model call (`llm_completion`, or a step that
 *    failed before a completion came back);
 *  - an `execute_tool` span per tool call (`tool_invocation`).
 *
 * The session is carried as `gen_ai.conversation.id` / `session.id` on
 * every span rather than as one long parent span: a session can stay
 * open for days, and a span is only exported once it ends.
 *
 * Text (the user message, the prompt tail, the reply, tool arguments,
 * error messages) goes into spans only with `captureContent`, and even
 * then through the shared secret masker (`maskSecrets`) and a length cap.
 * Without it a span holds ids, names, models, counts, timings and
 * outcomes only. Other trace events inside an open turn become span
 * events with their numeric, boolean and fixed-vocabulary fields.
 */
import { maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import type {
  TraceError,
  TraceEvent,
  TraceLlmCompletion,
  TraceToolInvocation,
  TraceTurnStarted,
} from "../trace/trace-event.js";
import {
  SPAN_KIND_CLIENT,
  SPAN_KIND_INTERNAL,
  STATUS_ERROR,
  STATUS_OK,
  STATUS_UNSET,
  msToUnixNano,
  newSpanId,
  newTraceId,
  toAttributes,
  type AttributeInput,
  type OtlpSpan,
  type OtlpSpanEvent,
} from "./otlp-json.js";

export interface OtlpSpanMapperOptions {
  /** Finished spans, in the order they end. Must not throw. */
  onSpan: (span: OtlpSpan) => void;
  /** Put prompt/reply/argument/error text into spans (masked, capped). */
  captureContent: boolean;
  /** The agent's own secrets, masked by exact value as well as by shape. */
  knownSecrets?: () => readonly KnownSecret[];
  /** `gen_ai.agent.name`. */
  agentName?: string;
  /** Open turns kept at once; the oldest is ended as unfinished beyond it. */
  maxOpenTurns?: number;
  /** Span events kept on one turn span; later ones are counted, not kept. */
  maxEventsPerSpan?: number;
  /** Longest text attribute, in characters, after masking. */
  maxContentChars?: number;
}

export interface OtlpSpanMapper {
  handle(event: TraceEvent): void;
  /** End every open turn (shutdown); they are marked unfinished. */
  endAll(nowMs?: number): void;
  openTurnCount(): number;
}

interface StepState {
  startMs: number;
  lastLlmEndMs?: number;
  sawCompletion: boolean;
  promptTail?: string;
}

interface TurnState {
  traceId: string;
  spanId: string;
  sessionId: string;
  turnIndex: number;
  startMs: number;
  lastMs: number;
  route: TraceTurnStarted["route"];
  attributes: Record<string, AttributeInput>;
  events: OtlpSpanEvent[];
  droppedEvents: number;
  steps: Map<number, StepState>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sawCost: boolean;
  llmCalls: number;
  toolCalls: number;
  errorType?: string;
  errorMessage?: string;
}

/** Span-event fields that are fixed vocabularies, never free text. */
const SAFE_STRING_FIELDS = new Set([
  "tool", "level", "detector", "outcome", "kind", "retry", "source",
  "category", "cause", "phase", "causeCode", "providerId", "stopType",
]);
const IGNORED_FIELDS = new Set(["type", "seq", "sessionId", "ts", "turnIndex"]);

const DEFAULT_MAX_OPEN_TURNS = 256;
const DEFAULT_MAX_EVENTS = 128;
const DEFAULT_MAX_CONTENT = 16_384;

export function createOtlpSpanMapper(options: OtlpSpanMapperOptions): OtlpSpanMapper {
  const agentName = options.agentName ?? "atomic-agent";
  const maxOpenTurns = options.maxOpenTurns ?? DEFAULT_MAX_OPEN_TURNS;
  const maxEvents = options.maxEventsPerSpan ?? DEFAULT_MAX_EVENTS;
  const maxContent = options.maxContentChars ?? DEFAULT_MAX_CONTENT;
  const knownSecrets = options.knownSecrets ?? (() => []);
  const turns = new Map<string, TurnState>();

  const text = (raw: string): string => {
    const masked = maskSecrets(raw, knownSecrets());
    return masked.length > maxContent ? `${masked.slice(0, maxContent)}…[truncated]` : masked;
  };
  const content = (raw: string | undefined): string | undefined =>
    options.captureContent && raw !== undefined && raw.length > 0 ? text(raw) : undefined;
  const messages = (role: string, raw: string | undefined): string | undefined => {
    const body = content(raw);
    return body === undefined
      ? undefined
      : JSON.stringify([{ role, parts: [{ type: "text", content: body }] }]);
  };

  const emit = (span: OtlpSpan): void => {
    try {
      options.onSpan(span);
    } catch {
      // A broken exporter must never reach the agent loop.
    }
  };

  const commonAttributes = (turn: TurnState): Record<string, AttributeInput> => ({
    "gen_ai.conversation.id": turn.sessionId,
    "session.id": turn.sessionId,
    "gen_ai.agent.name": agentName,
  });

  const step = (turn: TurnState, stepIndex: number, ts: number): StepState => {
    let state = turn.steps.get(stepIndex);
    if (!state) {
      state = { startMs: ts, sawCompletion: false };
      turn.steps.set(stepIndex, state);
    }
    return state;
  };

  const endTurn = (
    turn: TurnState,
    endMs: number,
    outcome: { reason?: string; stepCount?: number; unfinished?: boolean },
  ): void => {
    turns.delete(turn.sessionId);
    const failed = outcome.reason === "failed";
    const status = failed
      ? { code: STATUS_ERROR, message: turn.errorMessage ?? "turn failed" }
      : outcome.reason === "reply" || outcome.reason === "finish"
        ? { code: STATUS_OK }
        : { code: STATUS_UNSET };
    if (turn.droppedEvents > 0) {
      turn.attributes["atomic.span.dropped_events"] = turn.droppedEvents;
    }
    emit({
      traceId: turn.traceId,
      spanId: turn.spanId,
      name: `invoke_agent ${agentName}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToUnixNano(turn.startMs),
      endTimeUnixNano: msToUnixNano(Math.max(endMs, turn.startMs)),
      attributes: toAttributes({
        "gen_ai.operation.name": "invoke_agent",
        ...commonAttributes(turn),
        ...turn.attributes,
        "gen_ai.usage.input_tokens": turn.llmCalls > 0 ? turn.inputTokens : undefined,
        "gen_ai.usage.output_tokens": turn.llmCalls > 0 ? turn.outputTokens : undefined,
        "gen_ai.usage.cost": turn.sawCost ? turn.costUsd : undefined,
        "atomic.turn.llm_calls": turn.llmCalls,
        "atomic.turn.tool_calls": turn.toolCalls,
        "atomic.turn.reason": outcome.reason,
        "atomic.turn.step_count": outcome.stepCount,
        "atomic.turn.unfinished": outcome.unfinished === true ? true : undefined,
        "error.type": failed ? (turn.errorType ?? "turn_failed") : undefined,
      }),
      ...(turn.events.length > 0 ? { events: turn.events } : {}),
      status,
    });
  };

  const startTurn = (event: TraceTurnStarted): void => {
    const previous = turns.get(event.sessionId);
    if (previous) endTurn(previous, event.ts, { unfinished: true });
    while (turns.size >= maxOpenTurns) {
      const oldest = turns.values().next().value as TurnState | undefined;
      if (!oldest) break;
      endTurn(oldest, oldest.lastMs, { unfinished: true });
    }
    const route = event.route;
    turns.set(event.sessionId, {
      traceId: newTraceId(),
      spanId: newSpanId(),
      sessionId: event.sessionId,
      turnIndex: event.turnIndex,
      startMs: event.ts,
      lastMs: event.ts,
      route,
      attributes: {
        "gen_ai.provider.name": route?.main.providerId,
        "gen_ai.request.model": route?.main.model ?? undefined,
        "atomic.run_mode": route?.mode,
        "atomic.fusion.worker.provider": route?.worker?.providerId,
        "atomic.fusion.worker.model": route?.worker?.model ?? undefined,
        "atomic.turn.index": event.turnIndex,
        "gen_ai.input.messages": messages("user", event.userMessage),
      },
      events: [],
      droppedEvents: 0,
      steps: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      sawCost: false,
      llmCalls: 0,
      toolCalls: 0,
    });
  };

  const chatSpan = (turn: TurnState, event: TraceLlmCompletion): void => {
    const state = step(turn, event.stepIndex, event.ts);
    const timing = event.timing;
    const measuredMs = timing ? timing.promptMs + timing.predictedMs : 0;
    const startMs = measuredMs > 0
      ? event.ts - measuredMs
      : (state.lastLlmEndMs ?? state.startMs);
    state.sawCompletion = true;
    state.lastLlmEndMs = event.ts;
    turn.llmCalls += 1;
    if (timing) {
      turn.inputTokens += timing.promptTokens;
      turn.outputTokens += timing.predictedTokens;
    }
    if (event.costUsd !== undefined) {
      turn.costUsd += event.costUsd;
      turn.sawCost = true;
    }
    const model = event.modelId ?? turn.route?.main.model ?? undefined;
    const finish = event.truncated ? "length" : event.stop ? "stop" : undefined;
    emit({
      traceId: turn.traceId,
      spanId: newSpanId(),
      parentSpanId: turn.spanId,
      name: model ? `chat ${model}` : "chat",
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: msToUnixNano(Math.min(startMs, event.ts)),
      endTimeUnixNano: msToUnixNano(event.ts),
      attributes: toAttributes({
        "gen_ai.operation.name": "chat",
        ...commonAttributes(turn),
        "gen_ai.provider.name": turn.route?.main.providerId,
        "gen_ai.request.model": turn.route?.main.model ?? undefined,
        "gen_ai.response.model": event.modelId ?? undefined,
        "gen_ai.response.id": event.generationId,
        "gen_ai.response.finish_reasons": finish ? [finish] : undefined,
        "gen_ai.usage.input_tokens": timing?.promptTokens,
        "gen_ai.usage.output_tokens": timing?.predictedTokens,
        "gen_ai.usage.cache_read.input_tokens":
          event.cacheHitTokens > 0 ? event.cacheHitTokens : undefined,
        "gen_ai.usage.reasoning_tokens": event.reasoningTokens,
        "gen_ai.usage.cost": event.costUsd,
        "atomic.step.index": event.stepIndex,
        "atomic.llm.attempt": event.attempt,
        "atomic.llm.stop_type": event.stopType,
        "atomic.llm.truncated": event.truncated ? true : undefined,
        "gen_ai.input.messages": messages("user", state.promptTail),
        "gen_ai.output.messages": messages("assistant", event.content),
      }),
      status: { code: STATUS_UNSET },
    });
  };

  const failedChatSpan = (turn: TurnState, event: TraceError, stepIndex: number): void => {
    const state = step(turn, stepIndex, event.ts);
    if (state.sawCompletion) return;
    state.sawCompletion = true;
    const model = turn.route?.main.model ?? undefined;
    emit({
      traceId: turn.traceId,
      spanId: newSpanId(),
      parentSpanId: turn.spanId,
      name: model ? `chat ${model}` : "chat",
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: msToUnixNano(Math.min(state.startMs, event.ts)),
      endTimeUnixNano: msToUnixNano(event.ts),
      attributes: toAttributes({
        "gen_ai.operation.name": "chat",
        ...commonAttributes(turn),
        "gen_ai.provider.name": turn.route?.main.providerId,
        "gen_ai.request.model": model,
        "gen_ai.response.id": event.generationId,
        "atomic.step.index": stepIndex,
        "error.type": event.category ?? "error",
        "atomic.error.cause_code": event.causeCode,
      }),
      status: { code: STATUS_ERROR, message: content(event.message) ?? "model call failed" },
    });
  };

  const toolSpan = (turn: TurnState, event: TraceToolInvocation): void => {
    const state = step(turn, event.stepIndex, event.ts);
    const startMs = state.lastLlmEndMs ?? state.startMs;
    turn.toolCalls += 1;
    const failed = event.status === "error";
    emit({
      traceId: turn.traceId,
      spanId: newSpanId(),
      parentSpanId: turn.spanId,
      name: `execute_tool ${event.tool}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToUnixNano(Math.min(startMs, event.ts)),
      endTimeUnixNano: msToUnixNano(event.ts),
      attributes: toAttributes({
        "gen_ai.operation.name": "execute_tool",
        ...commonAttributes(turn),
        "gen_ai.tool.name": event.tool,
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.arguments": options.captureContent
          ? text(safeJson(event.args))
          : undefined,
        "gen_ai.tool.call.result": content(event.summary),
        "atomic.step.index": event.stepIndex,
        "atomic.tool.batch_index": event.batchIndex,
        "atomic.tool.batch_size": event.batchSize,
        "atomic.tool.truncated": event.toolTruncated ? true : undefined,
        "error.type": failed ? "tool_error" : undefined,
      }),
      status: failed
        ? { code: STATUS_ERROR, message: content(event.summary) ?? "tool call failed" }
        : { code: STATUS_UNSET },
    });
  };

  const addEvent = (turn: TurnState, event: TraceEvent, name = event.type): void => {
    if (turn.events.length >= maxEvents) {
      turn.droppedEvents += 1;
      return;
    }
    const attributes: Record<string, AttributeInput> = {};
    for (const [key, value] of Object.entries(event)) {
      if (IGNORED_FIELDS.has(key)) continue;
      const name = key === "stepIndex" ? "atomic.step.index" : `atomic.${key}`;
      if (typeof value === "number" || typeof value === "boolean") {
        attributes[name] = value;
      } else if (typeof value === "string" && SAFE_STRING_FIELDS.has(key)) {
        attributes[name] = value.slice(0, 128);
      }
    }
    turn.events.push({
      timeUnixNano: msToUnixNano(event.ts),
      name,
      attributes: toAttributes(attributes),
    });
  };

  const handleError = (turn: TurnState, event: TraceError): void => {
    turn.errorType = event.category ?? "error";
    const message = content(event.message);
    if (message !== undefined) turn.errorMessage = message;
    if (turn.events.length < maxEvents) {
      turn.events.push({
        timeUnixNano: msToUnixNano(event.ts),
        name: "exception",
        attributes: toAttributes({
          "exception.type": event.category ?? "error",
          "exception.message": message,
          "atomic.error.cause_code": event.causeCode,
          "atomic.step.index": event.stepIndex,
        }),
      });
    } else {
      turn.droppedEvents += 1;
    }
    if (
      event.stepIndex !== undefined &&
      event.category !== "tool" &&
      event.category !== "cancelled"
    ) {
      failedChatSpan(turn, event, event.stepIndex);
    }
  };

  const handle = (event: TraceEvent): void => {
    if (event.type === "turn_started") {
      startTurn(event);
      return;
    }
    const turn = turns.get(event.sessionId);
    // Session-level rows and the memory sub-calls that settle after a
    // turn ended have no open turn to hang on; they stay local.
    if (!turn) return;
    turn.lastMs = Math.max(turn.lastMs, event.ts);
    switch (event.type) {
      case "turn_finished":
        endTurn(turn, event.ts, { reason: event.reason, stepCount: event.stepCount });
        return;
      case "step_started":
        turn.steps.set(event.stepIndex, { startMs: event.ts, sawCompletion: false });
        return;
      case "step_finished":
        return;
      case "prompt_captured":
        if (options.captureContent) step(turn, event.stepIndex, event.ts).promptTail = event.tail;
        return;
      case "llm_completion":
        chatSpan(turn, event);
        return;
      case "tool_invocation":
        toolSpan(turn, event);
        return;
      case "error":
        handleError(turn, event);
        return;
      case "session_started":
      case "trace_truncated":
        return;
      default:
        addEvent(turn, event);
    }
  };

  return {
    handle(event) {
      try {
        handle(event);
      } catch {
        // Mapping must never break the bus; a malformed row is skipped.
      }
    },
    endAll(nowMs = Date.now()) {
      for (const turn of [...turns.values()]) {
        endTurn(turn, Math.max(turn.lastMs, nowMs), { unfinished: true });
      }
    },
    openTurnCount: () => turns.size,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}
