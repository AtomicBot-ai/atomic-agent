import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { SessionState } from "../session/session-state.js";

/**
 * The machine-readable output of `atomic-agent run --output-format
 * json|stream-json` (ATO-2307). `stream-json` (also `--json`) writes one
 * JSON object per stdout line as the run goes, in the spirit of
 * `claude -p --output-format stream-json` and `codex exec --json`;
 * `json` writes only the final `result` object. Every object has a
 * `type`; fields are camelCase like the sidecar's NDJSON.
 */
export type RunJsonEvent = Record<string, unknown> & { type: string };

/** The step the next tool events belong to; tool events carry none of their own. */
export interface RunJsonCursor {
  step: number | null;
}

export function createRunJsonCursor(): RunJsonCursor {
  return { step: null };
}

/** The first line of a stream: which chat this run talks to. */
export function runStartEvent(input: {
  session: SessionState;
  resumed: boolean;
  providerId?: string;
  model?: string;
}): RunJsonEvent {
  return {
    type: "start",
    sessionId: input.session.id,
    cwd: input.session.workingDir,
    resumed: input.resumed,
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

/** One agent-loop event as a stream line, or null for events a script has no use for. */
export function runJsonEvent(
  event: AgentLoopEvent,
  cursor: RunJsonCursor,
): RunJsonEvent | null {
  switch (event.type) {
    case "turn_started":
      return { type: "turn_started", turn: event.turnIndex };
    case "step_started":
      cursor.step = event.stepIndex;
      return null;
    case "turn_finished":
      return {
        type: "turn_finished",
        turn: event.turnIndex,
        reason: event.reason,
        steps: event.stepCount,
        durationMs: event.durationMs,
      };
    case "loop_failed":
      return {
        type: "error",
        fatal: true,
        category: event.category,
        message: event.error.message,
      };
    case "llm_event": {
      const inner = event.event;
      if (inner.type === "tool_call_parsed") {
        return {
          type: "tool_call",
          step: cursor.step,
          tool: inner.call.tool,
          args: inner.call.args,
          batchIndex: inner.batchIndex,
        };
      }
      if (inner.type === "tool_call_executed") {
        return {
          type: "tool_result",
          step: cursor.step,
          tool: inner.result.tool,
          status: inner.result.status,
          summary: inner.result.summary,
          truncated: inner.result.truncated,
          batchIndex: inner.batchIndex,
          ...(inner.durationMs === undefined ? {} : { durationMs: inner.durationMs }),
        };
      }
      if (inner.type === "assistant_reply") {
        return {
          type: "message",
          text: inner.text,
          progress: inner.progressNote === true,
        };
      }
      if (inner.type === "step_error") {
        return {
          type: "error",
          fatal: false,
          step: cursor.step,
          category: inner.category,
          message: inner.error.message,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/** The last line of a stream, and the whole output of `--output-format json`. */
export function runResultEvent(input: {
  session: SessionState;
  reply: string | null;
  durationMs: number;
  isError: boolean;
}): RunJsonEvent {
  const { session } = input;
  return {
    type: "result",
    isError: input.isError,
    sessionId: session.id,
    status: session.status,
    result: input.reply,
    turns: session.turnCount,
    steps: session.stepCount,
    durationMs: input.durationMs,
    lastError: session.lastError,
    usage: session.sessionUsage ?? null,
  };
}

/** The `result` line when the run died before a chat ended (a boot or resume failure). */
export function runFatalResultEvent(message: string, durationMs: number): RunJsonEvent {
  return { type: "result", isError: true, error: message, durationMs };
}
