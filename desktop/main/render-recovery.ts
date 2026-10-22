/**
 * ATO-765 — a window whose page crashed is loaded again instead of left blank.
 *
 * On `render-process-gone` (anything but a clean exit) the window used to stay
 * empty or frozen until the person closed it, while the agent, its chats and
 * its running turns were fine in main: a page that loads takes the turns back
 * itself (agent:liveTurns, agent:replayApprovals). main.ts reloads it now, at
 * most MAX_RELOADS times in RELOAD_WINDOW_MS per window; a page that crashes
 * more often than that is not reloaded in a loop, the person is asked instead
 * (KEEPS_CRASHING: Reload or Quit).
 *
 * Pure: no Electron. The clock is handed in so the unit test drives it.
 */

export const RELOAD_WINDOW_MS = 60_000;
export const MAX_RELOADS = 2;

/** One window's crash budget. */
export class RenderRecovery {
  private reloads: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** The page is gone: `reload` while the budget allows, else `ask`. A reload spends the budget. */
  onGone(): "reload" | "ask" {
    const t = this.now();
    this.reloads = this.reloads.filter((at) => t - at < RELOAD_WINDOW_MS);
    if (this.reloads.length >= MAX_RELOADS) return "ask";
    this.reloads.push(t);
    return "reload";
  }

  /** The person chose Reload in the dialog: the budget starts over. */
  reset(): void {
    this.reloads = [];
  }
}

/** The dialog for a window that keeps crashing. Button 0 reloads, 1 quits. */
export const KEEPS_CRASHING = {
  message: "The window keeps crashing",
  detail: `It crashed more than ${MAX_RELOADS} times in a minute, so it was not reloaded again. Your chats and running tasks are kept in the background. Reload to try again, or quit the app.`,
  buttons: ["Reload", "Quit"],
} as const;
