import type { AgentLoopEvent } from "../agent/agent-contract.js";

/** A named extension frame for the chat stream. */
export interface MaintenanceFrame {
  name: string;
  payload: Record<string, unknown>;
}

/**
 * Context maintenance told to an HTTP host (ATO-259, ATO-295).
 *
 * Auto compaction runs inside the turn, before an inference, and can take
 * tens of seconds; the packer fallback silently leaves older history out.
 * The TUI shows both; an HTTP host saw nothing but a turn that stalled.
 * These frames are extensions only (the caller checks the opt-in), so the
 * OpenAI-compatible stream is unchanged. Counts and statuses only: no
 * summary text and no transcript content.
 *
 * `null` for every other event, and for a compaction event that belongs
 * to another session than the turn's.
 */
export function maintenanceFrame(event: AgentLoopEvent, sessionId: string): MaintenanceFrame | null {
  switch (event.type) {
    case "compaction_started":
      if (event.sessionId !== sessionId) return null;
      return frame("compaction_started", sessionId, {
        reason: event.reason,
        tokens_before: event.tokensBefore,
      });
    case "compaction_progress":
      if (event.sessionId !== sessionId) return null;
      return frame("compaction_progress", sessionId, {
        chunk: event.chunk,
        chunks: event.chunks,
        completed_chunks: event.completedChunks,
      });
    case "compaction_completed":
    case "compaction_failed": {
      if (event.sessionId !== sessionId) return null;
      const { result } = event;
      return frame(event.type, sessionId, {
        status: result.status,
        reason: result.reason,
        ...(typeof result.tokensBefore === "number" ? { tokens_before: result.tokensBefore } : {}),
        ...(typeof result.tokensAfter === "number" ? { tokens_after: result.tokensAfter } : {}),
        ...(event.type === "compaction_failed" && result.message ? { message: result.message } : {}),
      });
    }
    case "history_trimmed":
      return frame("history_trimmed", sessionId, {
        step_index: event.stepIndex,
        dropped_messages: event.droppedMessages,
        dropped_turns: event.droppedTurns,
        bound_by: event.boundBy,
      });
    default:
      return null;
  }
}

function frame(name: string, sessionId: string, fields: Record<string, unknown>): MaintenanceFrame {
  return { name, payload: { object: `atomic.${name}`, session_id: sessionId, ...fields } };
}
