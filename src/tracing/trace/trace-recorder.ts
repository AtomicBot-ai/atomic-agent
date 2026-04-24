import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { StepEvent } from "../../agent/step-executor.js";
import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";

import type { TraceEvent } from "./trace-event.js";
import type { TraceSink } from "./trace-bus.js";

export interface TraceRecorderOptions {
  sessionId: string;
  /**
   * Destination for the transformed events. Typically a
   * `TraceBus.emit`, but tests may inject a plain collector.
   */
  emit: TraceSink;
  /** Optional clock override — used by tests for deterministic timestamps. */
  now?: () => number;
}

export interface TraceRecorderBeginInfo {
  workingDir: string;
  metadata?: Record<string, unknown>;
}

export interface TraceRecorder {
  /**
   * Emit the synthetic `session_started` event. Must be called exactly
   * once per NDJSON file — the runtime calls it when a fresh session is
   * created or when it starts writing traces for an existing session.
   */
  beginSession(info: TraceRecorderBeginInfo): void;
  /** Transform and forward one `AgentLoopEvent` to the sink. */
  onAgentEvent(event: AgentLoopEvent): void;
}

/**
 * Stateful transformer that maps `AgentLoopEvent` / inner `StepEvent`
 * streams into the append-only `TraceEvent` union. Handles:
 * - buffering `user_message` so it can be attached to the next
 *   `turn_started` trace entry;
 * - pairing `tool_call_parsed` + `tool_call_executed` into a single
 *   `tool_invocation` trace event with both args and result;
 * - assigning a monotonic `seq` within the session.
 *
 * The recorder never throws: unknown event shapes are ignored.
 */
export function createTraceRecorder(
  options: TraceRecorderOptions,
): TraceRecorder {
  const now = options.now ?? (() => Date.now());
  const sessionId = options.sessionId;
  let seq = 0;
  let currentTurnIndex = 0;
  let currentStepIndex: number | null = null;
  let pendingUserMessage: string | null = null;
  let pendingCall: ToolCallPayload | null = null;

  const nextSeq = (): number => seq++;
  const push = (event: TraceEvent): void => options.emit(event);

  const onStepEvent = (inner: StepEvent): void => {
    if (currentStepIndex === null) return;
    switch (inner.type) {
      case "prompt_captured":
        push({
          type: "prompt_captured",
          seq: nextSeq(),
          sessionId,
          ts: now(),
          turnIndex: currentTurnIndex,
          stepIndex: inner.stepIndex,
          stablePrefixHash: inner.stablePrefixHash,
          tail: inner.tail,
          tokens: inner.tokens,
          slotId: inner.slotId,
          cacheReused: inner.cacheReused,
        });
        return;
      case "llm_raw_completion": {
        const completion = inner.completion;
        const reasoning =
          typeof completion.reasoningContent === "string" &&
          completion.reasoningContent.length > 0
            ? completion.reasoningContent
            : undefined;
        push({
          type: "llm_completion",
          seq: nextSeq(),
          sessionId,
          ts: now(),
          turnIndex: currentTurnIndex,
          stepIndex: inner.stepIndex,
          attempt: inner.attempt,
          content: completion.content,
          ...(reasoning !== undefined ? { reasoningContent: reasoning } : {}),
          ...(completion.timing
            ? {
                timing: {
                  promptMs: completion.timing.promptMs,
                  predictedMs: completion.timing.predictedMs,
                  promptTokens: completion.timing.promptTokens,
                  predictedTokens: completion.timing.predictedTokens,
                },
              }
            : {}),
          cacheHitTokens: completion.cacheHitTokens,
          modelId: completion.modelId,
          stop: completion.stop,
          truncated: completion.truncated,
        });
        return;
      }
      case "tool_call_parsed":
        pendingCall = inner.call;
        return;
      case "tool_call_executed": {
        const call = pendingCall;
        pendingCall = null;
        push({
          type: "tool_invocation",
          seq: nextSeq(),
          sessionId,
          ts: now(),
          turnIndex: currentTurnIndex,
          stepIndex: currentStepIndex,
          tool: inner.result.tool,
          args: call?.args ?? {},
          status: inner.result.status,
          summary: inner.result.summary,
          ...(inner.result.details !== undefined
            ? { details: inner.result.details }
            : {}),
          ...(inner.result.truncated ? { toolTruncated: true } : {}),
        });
        return;
      }
      case "parse_retry":
        push({
          type: "parse_retry",
          seq: nextSeq(),
          sessionId,
          ts: now(),
          turnIndex: currentTurnIndex,
          stepIndex: inner.stepIndex,
          attempt: inner.attempt,
          reason: inner.reason,
        });
        return;
      case "step_error":
        push({
          type: "error",
          seq: nextSeq(),
          sessionId,
          ts: now(),
          turnIndex: currentTurnIndex,
          stepIndex: currentStepIndex,
          message: inner.error.message,
          ...(inner.error.stack ? { stack: inner.error.stack } : {}),
          category: inner.category,
        });
        return;
      default:
        return;
    }
  };

  return {
    beginSession(info) {
      push({
        type: "session_started",
        seq: nextSeq(),
        sessionId,
        ts: now(),
        workingDir: info.workingDir,
        ...(info.metadata !== undefined ? { metadata: info.metadata } : {}),
      });
    },
    onAgentEvent(event) {
      switch (event.type) {
        case "user_message":
          pendingUserMessage = event.text;
          return;
        case "turn_started":
          currentTurnIndex = event.turnIndex;
          push({
            type: "turn_started",
            seq: nextSeq(),
            sessionId,
            ts: now(),
            turnIndex: event.turnIndex,
            ...(pendingUserMessage !== null
              ? { userMessage: pendingUserMessage }
              : {}),
          });
          pendingUserMessage = null;
          return;
        case "turn_finished":
          push({
            type: "turn_finished",
            seq: nextSeq(),
            sessionId,
            ts: now(),
            turnIndex: event.turnIndex,
            reason: event.reason,
            stepCount: event.stepCount,
            durationMs: event.durationMs,
          });
          return;
        case "step_started":
          currentStepIndex = event.stepIndex;
          pendingCall = null;
          push({
            type: "step_started",
            seq: nextSeq(),
            sessionId,
            ts: now(),
            turnIndex: currentTurnIndex,
            stepIndex: event.stepIndex,
          });
          return;
        case "step_finished":
          push({
            type: "step_finished",
            seq: nextSeq(),
            sessionId,
            ts: now(),
            turnIndex: currentTurnIndex,
            stepIndex: event.stepIndex,
            summary: event.summary,
            durationMs: event.durationMs,
          });
          currentStepIndex = null;
          pendingCall = null;
          return;
        case "loop_detected":
          push({
            type: "loop_detected",
            seq: nextSeq(),
            sessionId,
            ts: now(),
            turnIndex: currentTurnIndex,
            stepIndex: event.stepIndex,
            tool: event.tool,
            count: event.count,
          });
          return;
        case "loop_failed":
          push({
            type: "error",
            seq: nextSeq(),
            sessionId,
            ts: now(),
            turnIndex: currentTurnIndex,
            ...(currentStepIndex !== null
              ? { stepIndex: currentStepIndex }
              : {}),
            message: event.error.message,
            ...(event.error.stack ? { stack: event.error.stack } : {}),
            category: event.category,
          });
          return;
        case "llm_event":
          onStepEvent(event.event);
          return;
        default:
          return;
      }
    },
  };
}
