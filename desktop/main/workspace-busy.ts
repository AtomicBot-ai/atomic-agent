/**
 * ATO-733 (part of ATO-436) — a new working folder restarts `atag serve`,
 * which cuts every turn it is running. The window keeps the picker shut while
 * one of its own chats is answering (renderer `restartStopsTurn`, ATO-729),
 * but a turn can begin while the system's folder picker is open: another
 * chat, a scheduled task, a Telegram reply. main.ts asks this after the
 * picker closes and before it stops the agent; a busy answer goes back to
 * the window, which says "Not while a turn is running" and leaves the folder
 * as it was.
 *
 * `elsewhere`: the turn is one the window does not stream (only the agent's
 * /health `busyTurns` counts it), so the window can name it. An agent that
 * does not answer in time, or is too old to say, does not hold the change
 * back: that is how a switch treats it too (main.ts agent:busyAnywhere).
 *
 * Pure: every dependency is handed in, so the unit test drives it.
 */

export interface WorkspaceBusy {
  busy: true;
  elsewhere: boolean;
}

export interface WorkspaceBusyDeps {
  /** The turns this client streams right now (AgentClient.turnsInFlight). */
  windowTurns(): number;
  /** /health `busyTurns`, or null when the agent is not up or cannot say. */
  agentTurns(): Promise<number | null>;
  /** How long the agent's answer is waited for. */
  timeoutMs: number;
}

/** Null when the folder can change now; else why not. */
export async function workspaceChangeBusy(deps: WorkspaceBusyDeps): Promise<WorkspaceBusy | null> {
  if (deps.windowTurns() > 0) return { busy: true, elsewhere: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const turns = await Promise.race([
    deps.agentTurns().catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  // A turn may have begun in a window chat while the agent was asked.
  if (deps.windowTurns() > 0) return { busy: true, elsewhere: false };
  return typeof turns === "number" && turns > 0 ? { busy: true, elsewhere: true } : null;
}
