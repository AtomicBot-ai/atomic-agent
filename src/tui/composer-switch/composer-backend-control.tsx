import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { llmHealthLook } from "../components/llm-health-badge.js";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { fusionChipColors, fusionSurfaceInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";
import type { ComposerBackendMeta } from "./composer-backend-selectors.js";

export interface ComposerBackendLook {
  readonly glyph: string;
  readonly color: string;
  /**
   * Retained for callers that render the probe in full — the Models
   * pane does. The composer row deliberately shows the dot alone.
   */
  readonly word: string | null;
}

/**
 * What the backend control shows for its status — or `null` for silence.
 *
 * `unknown` draws nothing at all: the shared glyph table's `·` is the
 * very character the row uses as a separator, and the old health pill
 * never appeared in this state either (`localConfigured` gated it), so
 * silence *is* the pill's information content. Cloud keeps its
 * historical green dot but no word — there is no probe behind it, and
 * printing "healthy" would claim an observation nobody made. Local,
 * custom and fusion carry the probe's word (healthy / probing / down /
 * error) the way the pill did.
 *
 * The look is asked for on the `"rail"` ground: this control sits on the
 * meta bar, and every dot the table hands back for the page — green,
 * amber, red — was picked to be read against the terminal's own
 * background. Only `unreachable` used to be corrected for that, one
 * token at a time; the ground is now a parameter, so all five come back
 * right.
 */
export function composerBackendLook(
  backend: ComposerBackendMeta,
): ComposerBackendLook | null {
  if (backend.status === "unknown") return null;
  const look = llmHealthLook(backend.status, "rail");
  return {
    glyph: look.glyph,
    color: look.color,
    word: backend.kind === "cloud" ? null : look.label,
  };
}

/**
 * The first of the composer's route controls: the health dot and the
 * backend word. `cloud` / `local` / `custom` are rail text like the
 * provider and the model beside them; `fusion` is an orange chip, the
 * one control on the bar that is not white, because it names a mode the
 * operator is *in* rather than a route they merely picked. The chip's
 * ink is measured against the chip's own ground, so the palette's
 * page-orange never lands as text on the rail (the contrast trap
 * `DownloadModelControl` documents).
 */
export function BackendControl({
  backend,
  fusion = false,
  mouseLayer,
}: {
  backend: ComposerBackendMeta;
  /** Paint the neighbouring ink on the Fusion surface. */
  fusion?: boolean;
  mouseLayer?: number;
}): ReactElement {
  const look = composerBackendLook(backend);
  const mouse = useMouseCommands();
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse || !isPrimaryPress(hit.event)) return false;
      mouse.dispatch({ type: "composer_switch_opened", kind: "backend" });
      return true;
    },
    mouseLayer === undefined ? {} : { layer: mouseLayer },
  );
  const chip = backend.kind === "fusion" ? fusionChipColors() : null;
  return (
    <Box ref={ref} flexShrink={0} minWidth={0}>
      <Text wrap="truncate">
        {look ? <Text color={look.color} bold>{`${look.glyph} `}</Text> : null}
        {chip ? (
          <Text backgroundColor={chip.background} color={chip.ink} bold>
            {` ${backend.kind} `}
          </Text>
        ) : (
          <Text
            color={fusion ? fusionSurfaceInk() : theme.colors.railForeground}
            bold
          >
            {backend.kind}
          </Text>
        )}
      </Text>
    </Box>
  );
}
