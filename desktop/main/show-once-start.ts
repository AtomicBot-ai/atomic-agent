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

/** The slice of uiohook-napi a recording uses (show-once-ipc.ts). */
export interface HookMouse { button: number; clicks: number; x: number; y: number }
export interface HookKey { keycode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
export interface ShowOnceHook {
  on(event: "mousedown", fn: (e: HookMouse) => void): unknown;
  on(event: "keydown", fn: (e: HookKey) => void): unknown;
  removeListener(event: "mousedown" | "keydown", fn: (e: never) => void): unknown;
  start(): void;
  stop(): void;
}

/** Wires and starts the listener; when it cannot start, it is unwired and the error goes on. */
export function startShowOnceHook(h: ShowOnceHook, onMouse: (e: HookMouse) => void, onKey: (e: HookKey) => void): ShowOnceHook {
  h.on("mousedown", onMouse);
  h.on("keydown", onKey);
  try {
    h.start();
  } catch (err) {
    try { h.removeListener("mousedown", onMouse as (e: never) => void); h.removeListener("keydown", onKey as (e: never) => void); } catch { /* gone */ }
    throw err;
  }
  return h;
}
