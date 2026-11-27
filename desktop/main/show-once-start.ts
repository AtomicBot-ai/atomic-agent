/**
 * ATO-2401 "Show once": the order a recording starts in, kept free of
 * electron so a unit test can drive it (show-once-ipc.ts passes the real
 * menu bar item and the real uiohook listener).
 *
 * Recording must never run without its visible menu bar item, so the item
 * comes first and the listener second:
 *   - the item cannot be shown → nothing listens, `{ok:false, stage:"indicator"}`;
 *   - the listener cannot start → the item goes away, `{ok:false, stage:"listener"}`.
 */

export interface ShowOnceIndicator {
  destroy(): void;
}

export type ShowOnceCaptureStart<H, I> =
  | { ok: true; hook: H; indicator: I }
  | { ok: false; stage: "indicator" | "listener"; message: string };

export interface ShowOnceCaptureSteps<H, I> {
  /** Shows the menu bar item; throws when it cannot. */
  showIndicator: () => I;
  /** Loads, wires and starts the listener; throws when it cannot. */
  startListener: () => H;
}

const firstLine = (err: unknown): string =>
  String(err instanceof Error ? err.message.split(/\r?\n/)[0] : err).slice(0, 200);

export function startShowOnceCapture<H, I extends ShowOnceIndicator>(
  steps: ShowOnceCaptureSteps<H, I>,
): ShowOnceCaptureStart<H, I> {
  let indicator: I;
  try {
    indicator = steps.showIndicator();
  } catch (err) {
    return { ok: false, stage: "indicator", message: firstLine(err) };
  }
  try {
    return { ok: true, hook: steps.startListener(), indicator };
  } catch (err) {
    try { indicator.destroy(); } catch { /* gone */ }
    return { ok: false, stage: "listener", message: firstLine(err) };
  }
}
