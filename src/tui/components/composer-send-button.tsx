import { Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";

/** The label carries its own padding so the chip's ground reads as a button. */
const SEND_LABEL = " send → ";

export interface ComposerSendButtonProps {
  /** A disabled button still renders: it says the affordance exists. */
  enabled: boolean;
  onPress: () => void;
}

/**
 * The composer's one button, drawn as a chip inside the input field.
 *
 * It used to sit on the action bar under the field, at the far right.
 * That put the app's primary verb a row away from the text it acts on,
 * and it spent the one slot on the bar that a status readout wants. In
 * the field it stays at the same column and lands next to the caret.
 *
 * Every colour here is a *pair* taken from the theme rather than a
 * literal, and the pair is one the palette already guarantees to be
 * opposite: `chipBackground` against `chipForeground`. That is what
 * keeps the chip legible across all eleven palettes without a per-theme
 * table — the tokens flip polarity with the theme.
 *
 * A disabled Send drops to `badgeBackground` / `muted`, which is the
 * terminal's version of a ghost button: still there, still labelled,
 * visibly not pressable.
 */
export function ComposerSendButton({
  enabled,
  onPress,
}: ComposerSendButtonProps): ReactElement {
  const background = enabled
    ? theme.colors.chipBackground
    : theme.colors.badgeBackground;
  const foreground = enabled
    ? theme.colors.chipForeground
    : theme.colors.muted;
  const chip = (
    <Text backgroundColor={background} color={foreground} bold={enabled}>
      {SEND_LABEL}
    </Text>
  );
  const mouse = useMouseCommands();
  // No provider (component tests, the wizard's separate Ink tree) or
  // nothing to do: render the label and stop. Registering a target that
  // swallows the click without acting would be worse than no target.
  if (!mouse || !enabled) return chip;
  return (
    <MouseTarget
      flexShrink={0}
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
