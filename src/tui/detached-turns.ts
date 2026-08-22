import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { DEFAULT_RING_BUFFER_SIZE } from "./tui-state.js";

/**
 * Bookkeeping for turns the operator switched away from mid-run.
 *
 * The runtime needs none of this: `TurnController` already runs
 * sessions independently (AGENTS.md §"Concurrency contract"), so a turn
 * whose thread is no longer on screen simply keeps executing and saves
 * its transcript to its own session. What the TUI must track is the
 * abort handle — Esc in the new thread must abort nothing, switching
 * back must make Esc work again, and quit must be able to stop every
 * backgrounded turn.
 *
 * Keyed by session id: the per-session FIFO guarantees at most one
 * orchestrator-started turn per session, so one controller per key is a
 * structural fact rather than a hope.
 */
export class DetachedTurns {
  private readonly bySession = new Map<string, AbortController>();

  /** Park the running turn's controller when its thread leaves the screen. */
  park(sessionId: string, controller: AbortController): void {
    this.bySession.set(sessionId, controller);
  }

  /**
   * Remove and return the controller parked for `sessionId`, if any —
   * the switch-back re-attach. `null` means no backgrounded turn of
   * ours runs there (idle, or a turn from another origin).
   */
  take(sessionId: string): AbortController | null {
    const controller = this.bySession.get(sessionId);
    if (!controller) return null;
    this.bySession.delete(sessionId);
    return controller;
  }

  /** Is one of our backgrounded turns still running on `sessionId`? */
  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /**
   * Drop the entry for `sessionId` only if it still holds `controller`
   * — the turn finished while parked. The identity check keeps a
   * finished turn from releasing a successor parked under the same key.
   * Returns whether an entry was released, so the caller can run its
   * end-of-background-turn cleanup exactly once.
   */
  release(sessionId: string, controller: AbortController): boolean {
    if (this.bySession.get(sessionId) !== controller) return false;
    this.bySession.delete(sessionId);
    return true;
  }

  get size(): number {
    return this.bySession.size;
  }

  /** Abort every parked turn — quit / shutdown teardown. */
  abortAll(): void {
    for (const controller of this.bySession.values()) controller.abort();
    this.bySession.clear();
  }
}

/**
 * Rolling per-session log of the agent events emitted by a turn this
 * TUI started, kept so switching back into a detached thread can
 * repaint what the turn has said so far. `session_switched` rebuilds
 * the transcript from the STORED session, and a running turn saves only
 * when it finishes — so a thread backgrounded mid-first-turn would
 * otherwise reload as an empty page holding nothing but a spinner, the
 * operator's own prompt included.
 *
 * Recording starts when the turn starts, not when it is detached: the
 * switch-back wipes everything that was painted before the operator
 * left, so a replay must cover the whole turn, not just the away span.
 *
 * Bounded per session at the transcript's own ring size
 * (`DEFAULT_RING_BUFFER_SIZE`). On overflow the OLDEST events are
 * dropped and counted; the replay announces the gap instead of passing
 * the reconstruction off as whole, and the end-of-turn re-emit from the
 * saved session restores the authoritative transcript regardless.
 */
export class TurnEventBuffer {
  private readonly bySession = new Map<
    string,
    { events: AgentLoopEvent[]; dropped: number }
  >();

  /** Start (or restart) recording the turn running on `sessionId`. */
  begin(sessionId: string): void {
    this.bySession.set(sessionId, { events: [], dropped: 0 });
  }

  /** Append one event; a no-op for sessions not being recorded. */
  record(sessionId: string, event: AgentLoopEvent): void {
    const log = this.bySession.get(sessionId);
    if (!log) return;
    if (log.events.length >= DEFAULT_RING_BUFFER_SIZE) {
      log.events.shift();
      log.dropped += 1;
    }
    log.events.push(event);
  }

  /** Everything recorded so far, or `null` when nothing is recording. */
  snapshot(
    sessionId: string,
  ): { events: readonly AgentLoopEvent[]; dropped: number } | null {
    const log = this.bySession.get(sessionId);
    if (!log) return null;
    return { events: [...log.events], dropped: log.dropped };
  }

  /** The turn ended — the saved session answers for it from here on. */
  end(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/** The switch-back replay lost its head to the ring cap. */
export function formatReplayGapNotice(dropped: number): string {
  return `re-attached mid-turn — the earliest ${dropped} event${
    dropped === 1 ? "" : "s"
  } of this turn no longer fit the replay buffer and were dropped; the full transcript returns when the turn finishes`;
}

/**
 * A session that is not on screen is parked on an approval. The request
 * stays pending at the gate — keys must never answer for an off-screen
 * thread — so the visible transcript gets this pointer instead, and
 * switching into the owner re-raises the actual prompt.
 */
export function formatBackgroundApprovalNotice(
  request: ApprovalRequest,
): string {
  return `session ${request.sessionId} is waiting for an approval (${request.tool}) — switch to it to answer; its turn is paused until you do`;
}

/**
 * Decision reason recorded when a switch-away denies a pending
 * approval. The blocked tool call reports it back to the model, so it
 * is written for the model to act on, not only for the operator.
 */
export const SWITCHED_AWAY_APPROVAL_REASON =
  "the operator switched to another session before answering — ask again if the action is still needed";

/** One-row preview for a message being dropped: flattened and elided. */
export function droppedPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}

/** Announce the detach itself, in the transcript being switched to. */
export function formatDetachedTurnNotice(sessionId: string): string {
  return `the running turn continues in the background on session ${sessionId} — switch back to watch or stop it`;
}

/** A backgrounded turn completed; its reply lives in its own thread. */
export function formatBackgroundTurnFinished(sessionId: string): string {
  return `background turn finished on session ${sessionId} — open it from the sidebar to read the reply`;
}

/** A backgrounded turn failed; name the thread so the error reads right. */
export function formatBackgroundTurnFailed(
  sessionId: string,
  message: string,
): string {
  return `background turn on session ${sessionId} failed: ${message}`;
}

/**
 * Steers a backgrounded turn accepted but never delivered. They cannot
 * be re-queued — the visible queue now feeds another thread — so the
 * drop is announced with previews, the same shape as the abort path.
 */
export function formatDroppedSteersNotice(
  sessionId: string,
  undelivered: readonly string[],
): string {
  return [
    `background turn on session ${sessionId} ended before reading ${
      undelivered.length
    } steering message${undelivered.length === 1 ? "" : "s"} — dropped:`,
    ...undelivered.map((text, i) => `  ${i + 1}. ${droppedPreview(text)}`),
  ].join("\n");
}

/** Parked messages dropped because the operator switched threads. */
export function formatDroppedQueueOnSwitchNotice(
  dropped: readonly string[],
): string {
  return [
    `switched away: dropped ${dropped.length} parked message${
      dropped.length === 1 ? "" : "s"
    } aimed at the previous session`,
    ...dropped.map((text, i) => `  ${i + 1}. ${droppedPreview(text)}`),
  ].join("\n");
}
