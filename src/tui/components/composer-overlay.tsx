import { Box } from "ink";
import type { ReactElement, ReactNode } from "react";

import { useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
/**
 * The composer's chrome: every row `PromptShell` costs besides the
 * editor lines themselves — the top margin (1), the frame's two
 * borders, the blank row above and below the buffer, and the meta bar
 * with its own padding row above and below (3). Counted off the
 * rendered component and pinned by the collapsed-shape frame test in
 * `composer-overlay.test.tsx`.
 *
 * Deliberately NOT derived from `debug-pane.tsx`'s `COMPOSER_ROWS`:
 * that is a *budget* and errs one row generous on purpose (the same
 * philosophy as its `RENDER_SAFETY_ROWS`), while the slot below must be
 * the exact height the collapsed composer paints — a slot one row too
 * tall leaves a permanent blank stripe over the transcript.
 */
export const COMPOSER_CHROME_ROWS = 8;

/**
 * Rows the collapsed composer actually paints: the chrome plus its one
 * editor line. This is what the flex column reserves.
 */
export const COMPOSER_COLLAPSED_ROWS = COMPOSER_CHROME_ROWS + 1;

/**
 * Rows of the pane the expanded composer must always leave visible
 * under the hairline. Two rows keep the top of the transcript (or the
 * splash) peeking out, which is what tells the operator the content is
 * covered rather than gone.
 */
const CONTEXT_ROWS_KEPT = 2;

/** The editor never windows below this, however short the terminal. */
const MIN_EDITOR_LINES = 3;

/**
 * The growth cap: how many editor lines the composer may show at once
 * given the rows of the stage it floats in (content pane + its own
 * reserved slot). Derived from the stage rather than the terminal so
 * the overlay can never climb past the stage's top edge — i.e. never
 * under the status bar, whose rows are outside the stage by
 * construction.
 */
export function maxComposerEditorLines(stageRows: number): number {
  return Math.max(
    MIN_EDITOR_LINES,
    stageRows - COMPOSER_CHROME_ROWS - CONTEXT_ROWS_KEPT,
  );
}

/**
 * The fixed-height slot the composer owns in the flex column. It never
 * changes size — which is the whole point: a growing buffer must not
 * reflow the chat log, the queued strip or the modals, so the flex
 * column only ever sees the collapsed height while the real composer
 * paints over the slot from {@link ComposerOverlay}. Same rows the
 * in-flow `PromptShell` used to take, so `computeChatViewportRows`'s
 * chrome budget still holds.
 */
export function ComposerSlot(): ReactElement {
  return <Box height={COMPOSER_COLLAPSED_ROWS} flexShrink={0} />;
}

/**
 * Floats the composer over the content pane, bottom-anchored.
 *
 * The house overlay technique is `menu-popup.tsx`'s: absolute
 * positioning inside a relative pane, opaque because terminals have no
 * compositing. Two deltas from the menu:
 *
 * - Anchoring is by inset (`bottom/left/right: 0`), not by a computed
 *   `marginTop`: Yoga resolves the insets against the parent's final
 *   size, so the box hugs the stage's bottom edge and grows *upward*
 *   with its content — no measurement pass, no height arithmetic that
 *   a wrapped meta-row could put off by one.
 * - Opacity comes from `PromptShell`'s own frame: Ink 7 paints a box's
 *   `backgroundColor` across its full interior (`render-background.js`
 *   fills every row with spaces), so the frame occludes edge to edge
 *   without per-line padding. The one see-through row is the shell's
 *   top margin, which sits *above* the frame and is meant to show the
 *   content behind.
 *
 * The mouse backstop is the popup-frame pattern: the overlay's box
 * claims every press at `MOUSE_LAYER_PANEL`, so a click on composer
 * pixels can never fall through to the chat controls painted beneath.
 * The composer's own targets (editor body, Send, the context chip)
 * register on the same layer as smaller boxes, so the registry offers
 * them the press first. Wheel is declined on purpose — the whole-app
 * wheel target at the base layer owns transcript scrolling, exactly as
 * it did when the composer sat in the flex column.
 */
export function ComposerOverlay({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const backstopRef = useMouseTarget((hit) => isPrimaryPress(hit.event), {
    layer: MOUSE_LAYER_PANEL,
  });
  return (
    <Box
      ref={backstopRef}
      position="absolute"
      bottom={0}
      left={0}
      right={0}
      flexDirection="column"
    >
      {children}
    </Box>
  );
}
