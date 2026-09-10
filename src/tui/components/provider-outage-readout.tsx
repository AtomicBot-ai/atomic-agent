import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { openLocalModelsPane } from "../composer-switch/composer-switch-activate.js";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";

export interface ProviderOutageReadoutProps {
  /** The state and its numbers, from `formatProviderOutageParts`. */
  head: string;
  /** The reason, or `null`. The half that gives up columns. */
  tail: string | null;
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
 * **Two boxes, not one, and both go straight into the meta bar's row.**
 * The head — `waiting for provider 12s/300s` — cannot shrink; the reason
 * after it shrinks harder than anything in the route. That ordering is
 * the point: the counter is what tells an operator the wait is
 * progressing rather than hung, and it used to be the first thing to go
 * because the row shrank the readout as one blob.
 *
 * Two things were tried first and do not work, both re-measured against
 * a bar carrying its real right-hand group (`prompt-meta-bar.test.tsx`):
 * a `minWidth` floor on a single readout box — the floor held the
 * readout at its full 60 columns and the route was clipped off the row
 * instead (bar width 100) — and this same head/tail pair nested inside
 * one shrinking group box, where the head came out as `waiting for
 * provid…` despite its `flexShrink={0}` (bar width 100). The second is
 * worth stating precisely, because the obvious reading of it is wrong:
 * Yoga does honour the nested `flexShrink={0}`, it just honours it
 * *inside* a group that has itself already shrunk below the width of
 * its two unshrinkable children — and `MetaLeft`'s `overflow="hidden"`
 * then clips them. A rigid item can only defend its columns on the line
 * that is doing the shrinking. Hence the fragment: these two boxes are
 * siblings of the backend word, not children of a slot.
 *
 * `railWarn` while the wait is live, `railError` once it has run out —
 * both rail tokens, because this lands on the rail's ground and the
 * page-side `warn` / `error` pair is picked to be read on the terminal's
 * own background (`theme-contrast.test.ts` holds the rail set to AA
 * against `railBackground`). A live wait is not an error yet: the whole
 * point of the park is that it usually comes back.
 */
export function ProviderOutageReadout({
  head,
  tail,
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
  const color = givenUp ? theme.colors.railError : theme.colors.railWarn;
  return (
    <>
      {/*
        The click target rides the head, which is the half that is always
        on screen — a target on a reason that has been truncated to
        nothing is a target nobody can hit.
      */}
      <Box ref={ref} flexShrink={0}>
        <Text color={color} wrap="truncate">
          {head}
        </Text>
      </Box>
      {tail === null ? null : (
        <Box
          // Grows into whatever the head, the separator and the route
          // leave over, from a basis of zero — never shrinks. Yoga does
          // not resolve a shrink whose share exceeds the item's own
          // width: at composer width 119 a `flexShrink` tail simply
          // refused to give up its 31 columns and the route was clipped
          // off the row instead. Growing from nothing asks the same
          // question the other way round, and asks it in the direction
          // Yoga answers reliably — the reason appears only once
          // everything else on the row is already whole. `maxWidth`
          // stops it growing past its own text and opening a gap
          // before the separator.
          flexGrow={1}
          flexBasis={0}
          minWidth={0}
          maxWidth={tail.length}
        >
          <Text color={color} wrap="truncate">
            {tail}
          </Text>
        </Box>
      )}
    </>
  );
}
