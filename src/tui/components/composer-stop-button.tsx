import { Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { readableOn } from "../theme/readable-foreground.js";
import { theme } from "../theme/theme.js";

/** The label carries its own padding so the chip's ground reads as a button. */
const STOP_LABEL = " ■ stop ";

export interface ComposerStopButtonProps {
  onPress: () => void;
  /**
   * Mouse layer for the click target. Same story as the send chip: the
   * composer overlay floats over the chat log, so its button registers
   * above the base layer — otherwise a covered chat control could win
   * the click.
   */
  layer?: number;
}

/**
 * The composer's stop chip, drawn inside the input field while a turn
 * is in flight.
 *
 * Esc, Ctrl+C and `/abort` all stop the run already, but every one of
 * them is invisible: an operator watching a turn go wrong has no
 * on-screen control that says the run *can* be stopped, let alone where.
 * The hint strip advertises `[esc] abort`, yet the strip is one row of
 * muted text under everything else — a mouse user staring at a runaway
 * task deserves a button next to the field they are typing into.
 *
 * Unlike Send this chip has no disabled state: it only renders while
 * `status === "running"`, and a stop button that renders but refuses to
 * press would be worse than none. The caller owns that condition, the
 * same way it owns wiring the press to the one abort path Esc uses.
 *
 * The ground is the palette's `error` — stop is the composer's one
 * destructive verb and it should not dress like Send. `error` is a page
 * token, not one of the guaranteed chip pairs, so the ink is *measured*
 * against it (`readableOn`) instead of assumed; that is what keeps the
 * label legible across all eleven palettes without a per-theme table.
 */
export function ComposerStopButton({
  onPress,
  layer,
}: ComposerStopButtonProps): ReactElement {
  const background = theme.colors.error;
  const chip = (
    <Text backgroundColor={background} color={readableOn(background)} bold>
      {STOP_LABEL}
    </Text>
  );
  const mouse = useMouseCommands();
  // No provider (component tests, the wizard's separate Ink tree):
  // render the label and stop. Registering a target that swallows the
  // click without acting would be worse than no target.
  if (!mouse) return chip;
  return (
    <MouseTarget
      flexShrink={0}
      layer={layer}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onPress();
        return true;
      }}
    >
      {chip}
    </MouseTarget>
  );
}
