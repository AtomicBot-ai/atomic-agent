/**
 * Legacy Windows console (conhost) detection, and the one-row guard
 * that keeps full-height frames from scrolling it.
 *
 * The TUI pins its root box to `height={rows}` (see `tui-app.tsx`), so
 * every frame is exactly as tall as the terminal. That is safe on a
 * VT terminal that defers the end-of-line wrap: painting the last cell
 * of the last row leaves the cursor parked, and nothing scrolls. The
 * frozen conhost that ships inside Windows 10 is the terminal where
 * that guarantee has never held — a write that lands on the bottom
 * row can push the viewport up one line, after which the repaint's
 * cursor math is off by one: the whole UI "shakes", and the row that
 * scrolled away leaves the last row painted twice. Both symptoms are
 * the Win10 reports against v0.4.1/v0.4.2 (cmd and PowerShell — the
 * shell does not matter, the conhost window hosting it does).
 *
 * The synchronized-update bracketing (`synchronized-output.ts`) cannot
 * help here: conhost ignores DEC 2026, and the scroll is real movement
 * of the buffer, not tearing.
 *
 * So: when the host is a *legacy* conhost, report one row fewer to the
 * layout. No frame ever touches the bottom terminal row, so there is
 * nothing left to scroll. The cost is one blank row, paid only on the
 * one console that cannot be fixed (Win10's inbox conhost is frozen;
 * Windows Terminal ships the maintained fork).
 *
 * Detection is deliberately narrow — Windows, and neither of the two
 * variables every modern host sets:
 *   - `WT_SESSION` — Windows Terminal
 *   - `TERM_PROGRAM` — VS Code, mintty, and friends
 * A plain cmd/PowerShell window on Win10 sets neither.
 *
 * `ATOMIC_AGENT_CONHOST_GUARD=0` turns the guard off where it
 * misfires; `=1` forces it on anywhere, which is how the behaviour is
 * verified from a terminal that is not a conhost.
 */

export interface LegacyConhostOptions {
  /** Env source for detection + override; injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Platform under test; defaults to the live `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/**
 * True when stdout is (best guess) the frozen Win10 conhost rather
 * than a modern VT host. See the module comment for the reasoning and
 * the `ATOMIC_AGENT_CONHOST_GUARD` override.
 */
export function isLegacyConhost(options: LegacyConhostOptions = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = env.ATOMIC_AGENT_CONHOST_GUARD;
  if (override === "1") return true;
  if (override === "0") return false;
  if (platform !== "win32") return false;
  if (env.WT_SESSION) return false;
  if (env.TERM_PROGRAM) return false;
  return true;
}

/**
 * The row budget the layout may actually use. One row is reserved on a
 * legacy conhost so no frame reaches the terminal's bottom row; every
 * other host keeps the full height. Never returns less than 1.
 */
export function clampRowsForLegacyConhost(
  rows: number,
  legacyConhost: boolean,
): number {
  if (!legacyConhost) return rows;
  return Math.max(1, rows - 1);
}

/**
 * The one-time startup line for the transcript, or `null` off a legacy
 * conhost. Worded as a recommendation, not an error: the guard already
 * has the rendering handled — this is where the operator learns that a
 * better console exists.
 */
export function legacyConhostStartupHint(
  options: LegacyConhostOptions = {},
): string | null {
  if (!isLegacyConhost(options)) return null;
  return (
    "legacy Windows console detected — the bottom row is kept clear to " +
    "avoid scroll glitches; Windows Terminal (`wt`) renders this UI " +
    "properly (ATOMIC_AGENT_CONHOST_GUARD=0 disables the guard)"
  );
}
