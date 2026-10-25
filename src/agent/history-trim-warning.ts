import type { StructuredLogger } from "../tracing/structured-logger.js";

/**
 * ATO-295. The mechanical conversation packer left older transcript rows
 * out of the prompt to fit the model's context: auto compaction is off,
 * failed for this turn, or could not find a safe cut. Counts only. Rides
 * the `AgentLoopEvent` union so the TUI and the HTTP stream can tell the
 * user what the model can no longer see.
 */
export interface HistoryTrimmedEvent {
  type: "history_trimmed";
  stepIndex: number;
  /** Transcript rows (user, assistant and tool messages) left out. */
  droppedMessages: number;
  /** Whole earlier user turns (macro-turns) left out. */
  droppedTurns: number;
  /** Which limit made the cut. */
  boundBy: "pairs" | "tokens";
}

/** Counts a built prompt reports (`BuiltPrompt`). */
export interface HistoryTrimStats {
  droppedTurns: number;
  droppedPairs: number;
  conversationBoundBy: "pairs" | "tokens" | null;
}

/** Same bound as the profile-clip warning: forgetting costs one repeat. */
const MAX_TRACKED_SESSIONS = 256;

/**
 * Once per occurrence, not once per step. The packer remembers its cut
 * (`conversationPackStart`), so every later step of the session reports
 * the same dropped count until history is cut again. A notice is due
 * when that count changes; a build that drops nothing re-arms the
 * session, so a drop after a compaction is reported again.
 */
export class HistoryTrimWarnings {
  private readonly lastWarned = new Map<string, number>();

  shouldWarn(sessionId: string, droppedMessages: number): boolean {
    if (droppedMessages <= 0) {
      this.lastWarned.delete(sessionId);
      return false;
    }
    if (this.lastWarned.get(sessionId) === droppedMessages) return false;
    this.lastWarned.delete(sessionId);
    this.lastWarned.set(sessionId, droppedMessages);
    if (this.lastWarned.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.lastWarned.keys().next().value;
      if (oldest !== undefined) this.lastWarned.delete(oldest);
    }
    return true;
  }
}

export interface ReportHistoryTrimInput {
  warnings: HistoryTrimWarnings;
  sessionId: string;
  stepIndex: number;
  prompt: HistoryTrimStats;
  logger?: StructuredLogger;
  emit?: (event: HistoryTrimmedEvent) => void;
}

/** Warn (log + event) about a packer cut, subject to {@link HistoryTrimWarnings}. */
export function reportHistoryTrim(input: ReportHistoryTrimInput): void {
  const { prompt } = input;
  if (!input.warnings.shouldWarn(input.sessionId, prompt.droppedTurns)) return;
  const event: HistoryTrimmedEvent = {
    type: "history_trimmed",
    stepIndex: input.stepIndex,
    droppedMessages: prompt.droppedTurns,
    droppedTurns: prompt.droppedPairs,
    boundBy: prompt.conversationBoundBy ?? "tokens",
  };
  input.logger?.warn("older conversation left out of the prompt", {
    sessionId: input.sessionId,
    stepIndex: event.stepIndex,
    droppedMessages: event.droppedMessages,
    droppedTurns: event.droppedTurns,
    boundBy: event.boundBy,
  });
  input.emit?.(event);
}

/** The user-facing sentence, shared by the TUI and the docs. */
export const HISTORY_TRIMMED_NOTICE =
  "Older messages were left out to fit the model's context. Use /compact to summarize them instead.";
