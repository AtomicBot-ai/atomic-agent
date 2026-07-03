import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { StepEvent } from "../agent/step-events.js";
import type { StdioProtocol } from "./stdio-protocol.js";

/**
 * Translate the full `AgentLoopEvent` stream (including the nested
 * `StepEvent` variants carried inside `llm_event`) into namespaced NDJSON
 * events tagged with `sessionId` and the originating `chat.send`
 * `correlationId`. This is the per-session `eventHook` installed on
 * `turnController.enqueue`, so two concurrent sessions never cross-
 * contaminate their streams.
 *
 * Heavy / internal-only step variants (`prompt_built`, `llm_completed`,
 * `llm_raw_completion`) are intentionally dropped — the host gets the
 * compact `prompt.captured` summary instead of the raw prompt/completion
 * bodies.
 */
export function createAgentEventForwarder(
  protocol: StdioProtocol,
): (sessionId: string, correlationId?: string) => (event: AgentLoopEvent) => void {
  return (sessionId, correlationId) =>
    (event) => {
      switch (event.type) {
        case "user_message":
          protocol.emitEvent(
            "user.message",
            { sessionId, text: event.text },
            correlationId,
          );
          break;
        case "turn_started":
          protocol.emitEvent(
            "turn.started",
            { sessionId, turnIndex: event.turnIndex },
            correlationId,
          );
          break;
        case "turn_finished":
          protocol.emitEvent(
            "turn.finished",
            {
              sessionId,
              turnIndex: event.turnIndex,
              reason: event.reason,
              stepCount: event.stepCount,
              durationMs: event.durationMs,
            },
            correlationId,
          );
          break;
        case "step_started":
          protocol.emitEvent(
            "step.started",
            { sessionId, stepIndex: event.stepIndex },
            correlationId,
          );
          break;
        case "step_finished":
          protocol.emitEvent(
            "step.finished",
            {
              sessionId,
              stepIndex: event.stepIndex,
              summary: event.summary,
              durationMs: event.durationMs,
            },
            correlationId,
          );
          break;
        case "loop_detected":
          protocol.emitEvent(
            "loop.detected",
            {
              sessionId,
              tool: event.tool,
              count: event.count,
              stepIndex: event.stepIndex,
              ...(event.level !== undefined ? { level: event.level } : {}),
              ...(event.detector !== undefined
                ? { detector: event.detector }
                : {}),
            },
            correlationId,
          );
          break;
        case "loop_completed":
          if (event.reason === "finish" || event.reason === "max_steps") {
            protocol.emitEvent(
              "session.completed",
              { sessionId, reason: event.reason },
              correlationId,
            );
          }
          break;
        case "loop_failed":
          protocol.emitEvent(
            "session.failed",
            {
              sessionId,
              error: event.error.message,
              category: event.category,
            },
            correlationId,
          );
          break;
        case "llm_event":
          forwardStepEvent(protocol, sessionId, correlationId, event.event);
          break;
      }
    };
}

function forwardStepEvent(
  protocol: StdioProtocol,
  sessionId: string,
  correlationId: string | undefined,
  inner: StepEvent,
): void {
  switch (inner.type) {
    case "tool_call_parsed":
      protocol.emitEvent(
        "tool.call_started",
        {
          sessionId,
          stepIndex: -1,
          tool: inner.call.tool,
          args: inner.call.args,
          ...(inner.batchSize > 1
            ? { batchIndex: inner.batchIndex, batchSize: inner.batchSize }
            : {}),
        },
        correlationId,
      );
      break;
    case "tool_call_executed":
      protocol.emitEvent(
        "tool.call_result",
        {
          sessionId,
          stepIndex: -1,
          tool: inner.result.tool,
          status: inner.result.status,
          summary: inner.result.summary,
          truncated: inner.result.truncated,
          ...(inner.batchSize > 1
            ? { batchIndex: inner.batchIndex, batchSize: inner.batchSize }
            : {}),
        },
        correlationId,
      );
      break;
    case "assistant_reply":
      protocol.emitEvent(
        "assistant.reply",
        { sessionId, text: inner.text },
        correlationId,
      );
      break;
    case "assistant_delta":
      protocol.emitEvent(
        "assistant.delta",
        { sessionId, text: inner.text },
        correlationId,
      );
      break;
    case "reasoning_delta":
      protocol.emitEvent(
        "reasoning.delta",
        { sessionId, stepIndex: inner.stepIndex, text: inner.text },
        correlationId,
      );
      break;
    case "reasoning":
      protocol.emitEvent(
        "reasoning",
        { sessionId, stepIndex: inner.stepIndex, text: inner.text },
        correlationId,
      );
      break;
    case "rare_tool_autoloaded":
      protocol.emitEvent(
        "tool.autoloaded",
        {
          sessionId,
          tool: inner.tool,
          source: inner.source,
          stepIndex: inner.stepIndex,
        },
        correlationId,
      );
      break;
    case "prompt_captured":
      protocol.emitEvent(
        "prompt.captured",
        {
          sessionId,
          stepIndex: inner.stepIndex,
          stablePrefixHash: inner.stablePrefixHash,
          tokens: inner.tokens,
          slotId: inner.slotId,
          cacheReused: inner.cacheReused,
        },
        correlationId,
      );
      break;
    case "parse_retry":
      protocol.emitEvent(
        "parse.retry",
        {
          sessionId,
          stepIndex: inner.stepIndex,
          attempt: inner.attempt,
          reason: inner.reason,
        },
        correlationId,
      );
      break;
    case "batch_trimmed":
      protocol.emitEvent(
        "batch.trimmed",
        {
          sessionId,
          stepIndex: inner.stepIndex,
          originalSize: inner.originalSize,
          kept: inner.kept,
          dropped: inner.dropped,
          reason: inner.reason,
        },
        correlationId,
      );
      break;
    case "step_error":
      protocol.emitEvent(
        "error",
        {
          message: inner.error.message,
          code: `step_error:${inner.category}`,
          stack: inner.error.stack,
        },
        correlationId,
      );
      break;
    // prompt_built, llm_completed, llm_raw_completion: internal-only, dropped.
  }
}
