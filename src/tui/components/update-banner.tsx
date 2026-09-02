import { Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";

/**
 * The persistent "a newer release exists" strip at the right end of the
 * status bar.
 *
 * The startup {@link UpdateModal} already offers the update once; this
 * banner is what remains after the operator skips it. It has to survive
 * the whole session without stealing attention from the work — so it
 * sits in the one corner the eye only visits deliberately, and it never
 * blinks, animates, or claims a key. What it *does* claim is contrast:
 * the strip renders inverse-video, swapping ink and ground, which is
 * distinguishable on every palette by construction — whatever the
 * terminal's background is, the banner is its opposite. No hand-picked
 * colour can promise that across twelve palettes and user terminals.
 *
 * `Update` is the click target and runs the same path as the modal's
 * `y` (`onUpdateConfirmed` → `runUpdate`), including its refusal while
 * a turn is in flight. Without mouse support the banner is inert
 * signage, like every other chip — the modal remains the keyboard route.
 */
export interface UpdateBannerProps {
  latest: string;
  /**
   * Columns the banner may use. Ink wraps rather than clips, so an
   * over-wide banner would fold the one-row status bar into a
   * paragraph; the banner degrades instead — full sentence, then bare
   * version, then the button alone, then nothing.
   */
  budget: number;
}

/** The click target. Fixed label, so its width is a constant. */
const BUTTON = " Update ";

/** Cell between the label and the button. */
const GAP = 1;

export interface UpdateBannerPlan {
  /** Inverse-video label before the button; `null` for button-only. */
  label: string | null;
  /** Total cells the banner occupies, button included. */
  width: number;
}

/**
 * Which form fits the budget. Exported so the status bar can subtract
 * the banner's real width from the download chip's budget instead of
 * guessing — the two share the same row.
 */
export function planUpdateBanner(
  latest: string,
  budget: number,
): UpdateBannerPlan | null {
  const full = ` new version v${latest} available `;
  const short = ` v${latest} `;
  for (const label of [full, short]) {
    const width = label.length + GAP + BUTTON.length;
    if (width <= budget) return { label, width };
  }
  if (BUTTON.length <= budget) return { label: null, width: BUTTON.length };
  return null;
}

export function UpdateBanner({
  latest,
  budget,
}: UpdateBannerProps): ReactElement | null {
  const mouse = useMouseCommands();
  const plan = planUpdateBanner(latest, budget);
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
      {plan.label ? <Text inverse>{`${plan.label} `}</Text> : null}
      {mouse ? (
        <MouseTarget
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
      )}
    </>
  );
}
