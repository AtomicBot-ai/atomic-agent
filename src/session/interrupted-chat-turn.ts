import type { SessionState } from "./session-state.js";
import { INTERRUPTED_TURN_ENDING } from "./session-store.js";
import type { TurnProgress } from "./turn-progress.js";

/**
 * A chat turn a restart cut off, and the person's way to continue it
 * (ATO-448).
 *
 * A turn whose process stopped before it could write its end (a crash,
 * a kill, a quit or an update that did not wait for it) is ended by the
 * boot sweep or by shutdown with `INTERRUPTED_TURN_ENDING`, and its
 * progress marker (`turn-progress.ts`) stays on the row with the request
 * it was started with. Durable tasks are continued by the task runner;
 * a chat turn is never continued on its own: what it was doing may have
 * had side effects (a shell command, a file write, a message, a push)
 * that ran, half ran or never ran, so only the person starts it again,
 * once, and the model is told to check before repeating anything.
 *
 * Pure: the runtime (`runtime/interrupted-turns.ts`) reads the row and
 * marks the turn as resumed by dropping its marker.
 */
export interface InterruptedChatTurn {
  /** The request the cut-off turn was started with (no resume note). */
  readonly request: string;
  /** Steps it completed and checkpointed before it was cut off. */
  readonly stepsDone: number;
  /** When it started, ms since the epoch. */
  readonly startedAt: number;
}

/** The note the continuing turn starts with. */
export const INTERRUPTED_TURN_RESUME_NOTE =
  "The previous turn was cut off by a restart. Tools that were running may or may not have completed; " +
  "check the current state before repeating any action with side effects (shell commands, file writes, messages, git push).";

/** What separates the note from the request it continues. */
const REQUEST_HEADER = "\n\nThe interrupted request:\n";

/**
 * The turn `state` ended with, when a restart cut it off and it can be
 * continued: ended with `INTERRUPTED_TURN_ENDING` (not a person's stop,
 * not a failure), with its progress marker still there (not resumed
 * yet, not rolled back), and not a durable task's (the task runner owns
 * those). `null` otherwise.
 */
export function interruptedChatTurn(
  state: Pick<SessionState, "status" | "lastError">,
  progress: TurnProgress | null,
): InterruptedChatTurn | null {
  if (progress === null) return null;
  if (progress.options.taskId !== undefined) return null;
  if (state.status !== INTERRUPTED_TURN_ENDING.status) return null;
  if (state.lastError !== INTERRUPTED_TURN_ENDING.lastError) return null;
  const request = originalRequest(progress.request);
  if (request.trim().length === 0) return null;
  return {
    request,
    stepsDone: progress.stepsDone,
    startedAt: progress.startedAt,
  };
}

/**
 * The message of the turn that continues `turn`: the note, then the
 * request it was cut off on. The request is repeated because a turn cut
 * off before its first step finished left no checkpoint, so the stored
 * transcript may not hold it.
 */
export function interruptedTurnResumeMessage(turn: InterruptedChatTurn): string {
  const where =
    turn.stepsDone > 0
      ? ` It had completed ${turn.stepsDone} step${turn.stepsDone === 1 ? "" : "s"}; the conversation above shows them.`
      : "";
  return `[Resumed] ${INTERRUPTED_TURN_RESUME_NOTE}${where} Continue the request; do not redo finished work.${REQUEST_HEADER}${turn.request}`;
}

/**
 * A request as the person wrote it: a resumed turn that a second
 * restart cut off recorded the whole resume message, so the earlier
 * note is taken off rather than stacked.
 */
function originalRequest(request: string): string {
  if (!request.startsWith("[Resumed] ")) return request;
  const at = request.indexOf(REQUEST_HEADER);
  return at === -1 ? request : request.slice(at + REQUEST_HEADER.length);
}
