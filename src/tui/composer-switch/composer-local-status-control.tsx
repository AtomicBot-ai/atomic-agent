import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import type { ComposerLocalStatus } from "./composer-local-status.js";
import { openLocalModelsPane } from "./composer-switch-activate.js";

/**
 * The managed daemon's status word plus its current RAM appetite —
 * `healthy · 4.4 GB` — muted like the status word it replaces: this is
 * an annotation on the route, not a fourth route element. Clicking it
 * deep-links to the local models pane; the switch popups next door own
 * changing anything.
 *
 * Own file only for the composer-switch modules' size budget; it is
 * rendered exclusively by `ComposerMetaControls`.
 */
export function LocalStatusControl({
  status,
  lead,
  mouseLayer,
}: {
  status: ComposerLocalStatus;
  /** Draw the leading dot separator (owned by the control — see `Control`). */
  lead: boolean;
  /** See `ComposerMetaControlsProps.mouseLayer`. */
  mouseLayer?: number;
}): ReactElement {
  const mouse = useMouseCommands();
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse || !isPrimaryPress(hit.event)) return false;
      openLocalModelsPane(mouse.dispatch);
      return true;
    },
    mouseLayer === undefined ? {} : { layer: mouseLayer },
  );
  const label = status.ramLabel
    ? `${status.word} ${theme.glyphs.dotSeparator} ${status.ramLabel}`
    : status.word;
  return (
    <Box ref={ref} flexShrink={4} minWidth={0}>
      <Text wrap="truncate" color={theme.colors.railMuted}>
        {lead ? ` ${theme.glyphs.dotSeparator} ` : ""}
        {label}
      </Text>
    </Box>
  );
}
