import { getConfig, type PushNotifyConfig } from "../config/index.js";
import {
  formatApprovalPush,
  formatTurnPush,
  isPushReady,
  sendPush,
  type PushMessage,
} from "../notifications/index.js";
import type { ChatMessage, RunOutcome } from "./tui-state.js";

/**
 * The TUI's phone push (ATO-1129): the same two moments the terminal
 * bell covers — a turn that ran long or failed, and an approval left
 * waiting — sent to the ntfy topic in `notifications.push` when it is
 * on. Fire-and-forget: a push that does not go out never touches the
 * turn or the approval.
 */

/** `notifications.push` when it can send now, else `null`. Never throws. */
export function readReadyPush(): PushNotifyConfig | null {
  try {
    const push = getConfig().notifications.push;
    return isPushReady(push) ? push : null;
  } catch {
    return null;
  }
}

/**
 * The text the turn that just ended answered with: the last assistant
 * message after the last prompt, interim progress notes skipped. `null`
 * when the turn left none (a failure, a stop, a tool-only finish).
 */
export function lastReplyOfTurn(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && !m.steered) return null;
    if (m.role === "assistant" && !m.progressNote) return m.text;
  }
  return null;
}

export function firePush(push: PushNotifyConfig, message: PushMessage): void {
  void sendPush({ push, message }).catch(() => undefined);
}

export function pushTurnEnd(
  push: PushNotifyConfig,
  p: {
    outcome: RunOutcome;
    reason: string;
    stepCount: number;
    durationMs: number;
    messages: readonly ChatMessage[];
    workingDirName?: string | undefined;
  },
): void {
  firePush(
    push,
    formatTurnPush({
      outcome: p.outcome,
      reply: p.outcome === "completed" ? lastReplyOfTurn(p.messages) : null,
      reason: p.reason,
      stepCount: p.stepCount,
      durationMs: p.durationMs,
      workingDirName: p.workingDirName,
    }),
  );
}

/**
 * Ping about an approval only once it has waited `delayMs`: someone at
 * the keyboard answers first and the phone stays quiet. Returns the
 * cancel to call when the approval is answered.
 */
export function schedulePushForApproval(
  tool: string,
  delayMs: number,
): () => void {
  const timer = setTimeout(() => {
    const push = readReadyPush();
    if (push) firePush(push, formatApprovalPush(tool));
  }, Math.max(0, delayMs));
  timer.unref?.();
  return () => clearTimeout(timer);
}
