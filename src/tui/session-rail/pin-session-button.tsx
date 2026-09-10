import { Text } from "ink";
import type { ReactElement } from "react";

import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_BASE } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";

/** Cells the pin affordance occupies inside a row's ground: `↑` + a pad. */
export const PIN_COLUMNS = 2;

export interface PinSessionButtonProps {
  sessionId: string;
  pinned: boolean;
  /** The row carries inverse video (selected, or the one being dragged). */
  inverse: boolean;
}

/**
 * The `↑` at the right edge of every session row: click it to pin the
 * thread to the top of the rail, click it again to release it.
 *
 * Unlike the `[x]`, this one is painted on EVERY row rather than only
 * the selected one. Pinning is not destructive — the worst a mis-click
 * does is move a row, and the next click puts it back — and a mark that
 * only appears under the pointer cannot show which threads are already
 * pinned, which is half of what this control is for. Bright and bold
 * when pinned, dim when not, so the block reads at a glance.
 */
export function PinSessionButton({
  sessionId,
  pinned,
  inverse,
}: PinSessionButtonProps): ReactElement {
  const mouse = useMouseCommands();
  const glyph = (
    <Text
      color={pinned ? theme.colors.railForeground : theme.colors.railMuted}
      bold={pinned}
      {...(inverse ? { inverse: true } : {})}
    >
      {`${theme.glyphs.pinned} `}
    </Text>
  );
  if (!mouse) return glyph;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_BASE}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.callbacks.onSessionPinToggled?.(sessionId);
        return true;
      }}
    >
      {glyph}
    </MouseTarget>
  );
}
