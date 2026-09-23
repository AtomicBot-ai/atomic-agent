import type { ProfileClipStats } from "../prompt/clip-profile-section.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

/**
 * `### profile` did not fit `memory.profile.maxTokens` and whole fact
 * lines were left out of the prompt. Counts only. Rides the
 * `AgentLoopEvent` union so the trace recorder and the TUI feed get it
 * the way they get every other loop event.
 */
export interface ProfileClippedEvent {
  type: "profile_clipped";
  stepIndex: number;
  rendered: number;
  dropped: number;
  pinnedDropped: number;
  maxTokens: number;
}

/**
 * Bound on remembered sessions. A long-lived runtime serves sessions
 * without end; forgetting the oldest only costs that session one repeat
 * warning if it clips again.
 */
const MAX_TRACKED_SESSIONS = 256;

/**
 * Decides when a clip is worth saying out loud. The clip itself runs on
 * every step, and a store that does not fit today will not fit on the
 * next step either — warning each time would bury the one line that
 * matters. So: once per session, and again only when the number of
 * **pinned** facts left out changes.
 *
 * Not the total `dropped`: contextual facts are keyword-gated, so how
 * many of them are selected — and left out — moves with every user
 * message. In a store whose pinned facts already overflow (the issue's
 * own deployment) re-arming on the total would warn on most turns. The
 * pinned count does not depend on the message; it moves when the store
 * or the budget does, which is exactly when a second warning says
 * something new. A step that fits says nothing and does not re-arm.
 */
export class ProfileClipWarnings {
  private readonly lastWarned = new Map<string, number>();

  shouldWarn(sessionId: string, clip: ProfileClipStats): boolean {
    const signature = clip.pinnedDropped;
    if (this.lastWarned.get(sessionId) === signature) return false;
    this.lastWarned.delete(sessionId);
    this.lastWarned.set(sessionId, signature);
    if (this.lastWarned.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.lastWarned.keys().next().value;
      if (oldest !== undefined) this.lastWarned.delete(oldest);
    }
    return true;
  }
}

export interface ReportProfileClipInput {
  warnings: ProfileClipWarnings;
  sessionId: string;
  stepIndex: number;
  /** `BuiltPrompt.profileClip` — absent when everything fit. */
  clip: ProfileClipStats | undefined;
  logger?: StructuredLogger;
  emit?: (event: ProfileClippedEvent) => void;
}

/** Warn (log + event) about a clip, subject to {@link ProfileClipWarnings}. */
export function reportProfileClip(input: ReportProfileClipInput): void {
  const { clip } = input;
  if (clip === undefined || clip.dropped === 0) return;
  if (!input.warnings.shouldWarn(input.sessionId, clip)) return;
  input.logger?.warn("profile section clipped at memory.profile.maxTokens", {
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    rendered: clip.rendered,
    dropped: clip.dropped,
    pinnedDropped: clip.pinnedDropped,
    maxTokens: clip.maxTokens,
  });
  input.emit?.({
    type: "profile_clipped",
    stepIndex: input.stepIndex,
    rendered: clip.rendered,
    dropped: clip.dropped,
    pinnedDropped: clip.pinnedDropped,
    maxTokens: clip.maxTokens,
  });
}
