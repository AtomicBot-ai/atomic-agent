import { Text } from "ink";
import type { ReactElement } from "react";

import { codingModeLook, type CodingMode } from "../coding-mode.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { readableOn } from "../theme/readable-foreground.js";
import { theme } from "../theme/theme.js";

/**
 * The stance the session is in, at the right end of the composer's bar.
 *
 * Placed after the context chip on purpose. The bar reads left to right
 * as *where the work goes* — backend, model, how full the window is —
 * and this is the last thing in that sentence: under what rules. It is
 * also the one control on the bar that changes what the agent is allowed
 * to do, so it wants the end position, where the eye stops.
 *
 * **Colour carries the meaning, not just the word.** `default` is the
 * palette's success tone, `auto` its warn, `bypass permissions`
 * its error. That is not decoration: a chip a person stops reading after
 * the first week still has to say "you are not in normal mode" from
 * across the room, and on a strip this dense the word alone does not.
 * `plan` takes the accent instead of a hazard colour — it is the
 * *safest* mode, and painting the careful choice in a warning tone would
 * be exactly backwards.
 *
 * Ink drops a colour under `NO_COLOR`, so the label always spells the
 * mode out rather than relying on the tone.
 */
export function CodingModeChip({
  mode,
  layer,
}: {
  mode: CodingMode;
  /**
   * Mouse layer for the click target. Rendered inside the composer
   * overlay, which floats over the chat log, so it registers above the
   * base layer — otherwise a covered chat control could win the click.
   */
  layer?: number;
}): ReactElement {
  const look = codingModeLook(mode);
  const background =
    look.tone === "accent"
      ? theme.colors.accent
      : look.tone === "success"
        ? theme.colors.success
        : look.tone === "warn"
          ? theme.colors.warn
          : theme.colors.error;
  const chip = (
    <Text backgroundColor={background} color={readableOn(background)} bold>
      {` ${look.label} `}
    </Text>
  );
  const mouse = useMouseCommands();
  // No provider (component tests, the wizard's separate Ink tree):
  // render the label and stop. A target that swallowed the click
  // without acting would be worse than no target.
  if (!mouse) return chip;
  return (
    <MouseTarget
      flexShrink={0}
      layer={layer}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // Opens the menu; it does not cycle. Advancing the ring on a
        // bare click made the one control that changes what the agent
        // may do the only one with no confirmation and no explanation.
        mouse.dispatch({ type: "coding_mode_menu_opened" });
        return true;
      }}
    >
      {chip}
    </MouseTarget>
  );
}
