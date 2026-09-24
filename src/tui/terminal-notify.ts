import type { RunOutcome } from "./tui-state.js";

/**
 * Tell the terminal a turn ended, so the operator who walked away finds
 * out without watching.
 *
 * **Why the terminal and not a desktop API.** The agent runs in a TTY
 * that may be over SSH, in tmux, on a machine with no notification
 * daemon and no permission to talk to one. `OSC 9` is the one channel
 * that follows the session instead of the process: iTerm2, WezTerm,
 * Windows Terminal and kitty raise a real notification from it, and
 * every other terminal ignores the sequence silently. The `BEL` that
 * follows is the floor — Terminal.app and most of the rest turn it into
 * a badge, a dock bounce, or an audible bell, which is still "something
 * happened over here".
 *
 * **Why stderr.** Ink owns stdout and repaints it as a frame; an
 * out-of-band escape written there lands inside a frame and the next
 * repaint can leave it on screen as garbage. stderr goes to the same
 * terminal, is read for OSC just the same, and Ink never touches it.
 */

/** ASCII BEL — the string terminator OSC 9 expects, and the fallback. */
const BEL = String.fromCharCode(7);
const OSC = `${String.fromCharCode(27)}]`;

/**
 * Strip what must never reach an OSC payload: the terminator itself,
 * ESC (which would start a new sequence), and the C1 ST. A turn's
 * failure message is model-adjacent text — it is not a place to trust
 * that no control byte ever appears.
 */
export function sanitizeNotificationText(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 7 || code === 27 || code === 0x9c) return false;
      return code >= 32 || code === 9;
    })
    .join("")
    .slice(0, 160);
}

export interface TurnNotification {
  title: string;
  body: string;
}

/**
 * What the notification says. One line, because that is all a terminal
 * notification reliably shows — and it leads with the outcome, since
 * the whole point is to be readable from a glance at a corner of a
 * screen the operator is not looking at.
 */
export function formatTurnNotification(params: {
  outcome: RunOutcome;
  reason: string;
  stepCount: number;
  durationMs: number;
  workingDirName?: string | undefined;
}): TurnNotification {
  const seconds = Math.round(params.durationMs / 1000);
  const took =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
      : `${seconds}s`;
  const where = params.workingDirName ? ` · ${params.workingDirName}` : "";
  const head =
    params.outcome === "failed"
      ? "atomic-agent: turn failed"
      : params.outcome === "cancelled"
        ? "atomic-agent: turn cancelled"
        : "atomic-agent: turn done";
  const steps = `${params.stepCount} step${params.stepCount === 1 ? "" : "s"}`;
  return {
    title: head,
    body: sanitizeNotificationText(
      `${params.reason} · ${steps} · ${took}${where}`,
    ),
  };
}

/**
 * Whether this ending is worth interrupting someone for.
 *
 * A failure always is: it is the ending that needs a person, and it can
 * happen in two seconds. A turn that simply finished is only worth a
 * ping if it ran long enough that the operator plausibly stopped
 * watching — otherwise every "what's 2+2" rings the bell, which is how
 * an operator learns to ignore it.
 */
export function shouldNotify(params: {
  outcome: RunOutcome;
  durationMs: number;
  minDurationMs: number;
}): boolean {
  if (params.outcome === "failed") return true;
  return params.durationMs >= params.minDurationMs;
}

/** Write one notification, ignoring a stream that will not take it. */
export function emitTerminalNotification(
  write: (chunk: string) => void,
  note: TurnNotification,
): void {
  const title = sanitizeNotificationText(note.title);
  const body = sanitizeNotificationText(note.body);
  const text = body ? `${title} — ${body}` : title;
  try {
    // OSC 9 first, then a bare BEL for the terminals that ignore it.
    // The OSC's own terminator is a BEL, so a terminal that understands
    // the sequence consumes that one and rings on the second; one that
    // does not prints nothing (the payload is inside an OSC it drops)
    // and rings on both, which is the same event to a human.
    write(`${OSC}9;${text}${BEL}`);
    write(BEL);
  } catch {
    // A closed or non-TTY stderr is not a reason to fail a turn.
  }
}
