/**
 * ATO-370: on macOS, offer to move the app into /Applications at launch.
 *
 * Run from the DMG, Downloads or a translocated copy, the app cannot update
 * itself (updater.ts probeMacApp: `app.isInApplicationsFolder()` is false),
 * and until now it only said so in a line in Settings › General, so people
 * stayed on an old version without knowing. At launch it now asks
 * "Move Atomic Agent to Applications?" with Move and Not now. Move calls
 * `app.moveToApplicationsFolder()`, which moves the bundle, relaunches it
 * and handles an existing copy itself (a running one takes focus and this
 * one quits). Not now asks again on the next launch only: the question is
 * put once per launch, never on a window reopen, so nothing is stored.
 *
 * Never asked on other platforms, in a smoke run, in a dev run or from an
 * unpackaged app (`electron .` runs from the checkout, which a move would
 * break).
 *
 * Pure: no Electron import, so the unit suite can load it from `out/main`.
 */

export interface MoveOfferInput {
  platform: NodeJS.Platform;
  /** app.isPackaged */
  packaged: boolean;
  smoke: boolean;
  dev: boolean;
  /** app.isInApplicationsFolder(); null when it could not be read. */
  inApplications: boolean | null;
}

/** Whether this launch should ask. An unknown location never asks. */
export function shouldOfferMove(o: MoveOfferInput): boolean {
  return o.platform === "darwin" && o.packaged && !o.smoke && !o.dev && o.inApplications === false;
}

/** The question, as handed to dialog.showMessageBoxSync. Button 0 is Move. */
export const MOVE_PROMPT = {
  type: "question" as const,
  message: "Move Atomic Agent to Applications?",
  detail: "Updates only work from the Applications folder. The app moves itself there and opens again.",
  buttons: ["Move", "Not now"],
  defaultId: 0,
  cancelId: 1,
};

export type MoveOutcome = "moved" | "declined" | "failed";

export interface MoveDeps {
  /** Shows MOVE_PROMPT; the index of the button pressed. */
  ask: () => number;
  /** app.moveToApplicationsFolder(): true when the move happened (the app then quits and relaunches). */
  move: () => boolean;
  log: (line: string) => void;
}

/**
 * Asks, and moves on Move. A move that is refused or throws is logged and
 * the launch goes on from where it is: the Settings line still explains it.
 */
export function offerMove(deps: MoveDeps): MoveOutcome {
  if (deps.ask() !== 0) return "declined";
  try {
    if (deps.move()) return "moved";
    deps.log("[desktop] move to Applications: not moved");
  } catch (err) {
    deps.log(`[desktop] move to Applications failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return "failed";
}
