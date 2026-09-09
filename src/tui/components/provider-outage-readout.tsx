import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { openLocalModelsPane } from "../composer-switch/composer-switch-activate.js";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";

export interface ProviderOutageReadoutProps {
  /** Already-formatted line from `formatProviderOutage`. */
  text: string;
  /** The wait budget ran out — the sticky, past-tense half. */
  givenUp: boolean;
  /** See `ComposerMetaControlsProps.mouseLayer`. */
  mouseLayer?: number;
}

/**
 * The meta bar's provider-outage line, as a button.
 *
 * Clicking it lands in Manage › LLM — the pane that owns the route the
 * outage is about, where the URL can be checked and the backend
 * switched. The same deep link the `download model` slot uses, for the
 * same reason: the row states a problem, so the one gesture it invites
 * should reach the place the problem is fixed.
 *
 * `useMouseTarget` on a Box rather than the `MouseTarget` wrapper, and
 * a Box rather than a bare `<Text>`: a click target *is* a Box, and Ink
 * cannot nest one inside a `<Text>` — it renders in unit tests and
 * crashes in a real terminal. The Box therefore has to be handed to the
 * meta bar as a self-contained element, which is why `MetaLeft` no
 * longer wraps its slot in a `<Text>` of its own.
 *
 * `railWarn` while the wait is live, `railError` once it has run out —
 * both rail tokens, because this lands on the rail's ground and the
 * page-side `warn` / `error` pair is picked to be read on the terminal's
 * own background (`theme-contrast.test.ts` holds the rail set to AA
 * against `railBackground`). A live wait is not an error yet: the whole
 * point of the park is that it usually comes back.
 */
export function ProviderOutageReadout({
  text,
  givenUp,
  mouseLayer,
}: ProviderOutageReadoutProps): ReactElement {
  const mouse = useMouseCommands();
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse || !isPrimaryPress(hit.event)) return false;
      openLocalModelsPane(mouse.dispatch);
      return true;
    },
    mouseLayer === undefined ? {} : { layer: mouseLayer },
  );
  return (
    <Box ref={ref} flexShrink={1} minWidth={0}>
      <Text
        color={givenUp ? theme.colors.railError : theme.colors.railWarn}
        wrap="truncate"
      >
        {text}
      </Text>
    </Box>
  );
}
