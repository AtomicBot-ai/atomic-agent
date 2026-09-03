import { Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";

/**
 * The persistent update strip at the right end of the status bar.
 *
 * The startup {@link UpdateModal} already offers the update once; this
 * banner is what remains after the operator skips it — and what narrates
 * the install once they accept. It has to survive the whole session
 * without stealing attention from the work, so it sits in the one corner
 * the eye only visits deliberately, and it never blinks, animates, or
 * claims a key. What it *does* claim is contrast: the strip renders
 * inverse-video, swapping ink and ground, which is distinguishable on
 * every palette by construction — whatever the terminal's background is,
 * the banner is its opposite. No hand-picked colour can promise that
 * across twelve palettes and user terminals.
 *
 * `Update` is the click target and runs the same path as the modal's
 * `y` (`onUpdateConfirmed` → `runUpdate`), including its refusal while
 * a turn is in flight. Without mouse support the banner is inert
 * signage, like every other chip — the modal remains the keyboard route.
 */
export interface UpdateBannerProps {
  latest: string;
  /**
   * Where the update is in its life. `offer` shows the sentence and the
   * button; `running` swaps them for "updating — do not close" (the
   * installer is replacing the binary and the one useful instruction is
   * to leave it alone); `done` says a restart applies it. The bar maps
   * `updateStatus` onto this — the failed state renders as a fresh
   * `offer`, because the button is then the way to retry.
   */
  phase: UpdateBannerPhase;
  /**
   * Columns the banner may use. Ink wraps rather than clips, so an
   * over-wide banner would fold the one-row status bar into a
   * paragraph; the banner degrades instead — full sentence, then a
   * terse one, then (for `offer`) the button alone, then nothing.
   */
  budget: number;
}

export type UpdateBannerPhase = "offer" | "running" | "done";

/** The click target. Fixed label, so its width is a constant. */
const BUTTON = " Update ";

export interface UpdateBannerPlan {
  /** Inverse-video label; `null` for the button-only offer form. */
  label: string | null;
  /** Whether the `Update` button renders (offer phase only). */
  button: boolean;
  /** Total cells the banner occupies, button included. */
  width: number;
}

/** Longest-first label ladder for each phase. */
function labelLadder(phase: UpdateBannerPhase, latest: string): string[] {
  switch (phase) {
    case "offer":
      return [` new version v${latest} available `, ` v${latest} `];
    case "running":
      // "do not close" is the payload: the installer is mid-way through
      // replacing the binary, and killing the terminal now is the one
      // thing the operator can do to make it worse.
      return [
        ` updating to v${latest} — do not close `,
        ` updating — do not close `,
        ` updating… `,
      ];
    case "done":
      return [
        ` updated to v${latest} — restart to apply `,
        ` restart to apply `,
        ` updated `,
      ];
  }
}

/**
 * Which form fits the budget. Exported so the status bar can subtract
 * the banner's real width from the download chip's budget instead of
 * guessing — the two share the same row.
 */
export function planUpdateBanner(
  latest: string,
  budget: number,
  phase: UpdateBannerPhase = "offer",
): UpdateBannerPlan | null {
  const button = phase === "offer";
  const buttonWidth = button ? BUTTON.length : 0;
  for (const label of labelLadder(phase, latest)) {
    const width = label.length + buttonWidth;
    if (width <= budget) return { label, button, width };
  }
  if (button && BUTTON.length <= budget)
    return { label: null, button, width: BUTTON.length };
  return null;
}

export function UpdateBanner({
  latest,
  phase,
  budget,
}: UpdateBannerProps): ReactElement | null {
  const mouse = useMouseCommands();
  const plan = planUpdateBanner(latest, budget, phase);
  if (!plan) return null;
  // Inverse accent: the palette's accent as ground, the terminal's own
  // background as ink. Louder than the inverse label beside it, so the
  // actionable cell reads as the button and the sentence as its caption.
  const button = (
    <Text color={theme.colors.accent} inverse bold>
      {BUTTON}
    </Text>
  );
  // Siblings, not one <Text> parent: `MouseTarget` wraps its child in a
  // Box to own a measurable region, and Ink refuses a Box inside Text.
  return (
    <>
      {plan.label ? <Text inverse>{plan.label}</Text> : null}
      {plan.button ? (
        mouse ? (
          <MouseTarget
            // The startup modal raises the mouse floor to the modal rung
            // (`modalOwnsInput`), and the obvious first click a fresh
            // launch invites is THIS button — with the offer modal still
            // on screen. Registering on the modal rung keeps the button
            // live through that floor; a click here is exactly the
            // modal's `y`, so answering the modal from the corner is the
            // same decision, not a bypass.
            layer={MOUSE_LAYER_MODAL}
            onMouse={(hit) => {
              if (!isPrimaryPress(hit.event)) return false;
              mouse.callbacks.onUpdateConfirmed?.();
              return true;
            }}
          >
            {button}
          </MouseTarget>
        ) : (
          button
        )
      ) : null}
    </>
  );
}
