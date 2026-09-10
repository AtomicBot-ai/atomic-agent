import { Box, Text } from "ink";
import { useEffect, useState, type ReactElement } from "react";

import {
  createStrip,
  MIN_STRIP_WIDTH,
  renderStrip,
  runsOf,
  stepStrip,
  STRIP_ROWS,
  type StripState,
} from "./swarm-critters.js";

/** Milliseconds between animation ticks. ~5 fps reads as scurrying without flicker. */
export const STRIP_TICK_MS = 180;

export interface ZerglingStripProps {
  /** Columns available to the strip. Below `MIN_STRIP_WIDTH` nothing is drawn. */
  width: number;
  /** Connected bots — one critter each. */
  count: number;
  /** `false` freezes the scene (reduced motion, tests). Default `true`. */
  animate?: boolean;
  /** Test seam — replaces `setInterval`. */
  schedule?: (cb: () => void, ms: number) => () => void;
}

/**
 * Three text rows of hatchery at the bottom of the Swarm pane. Mounted
 * only while that tab is shown, so the interval dies with the tab and
 * nothing ticks in the background. Never taller than `STRIP_ROWS`; the
 * pane decides whether it has the room.
 */
export function ZerglingStrip({
  width,
  count,
  animate = true,
  schedule,
}: ZerglingStripProps): ReactElement | null {
  const [state, setState] = useState<StripState>(() =>
    createStrip(width, count),
  );

  useEffect(() => {
    if (!animate) {
      // Still converge on the right number of critters — just without motion.
      setState((s) =>
        s.critters.length === count && s.width === width
          ? s
          : createStrip(width, count),
      );
      return;
    }
    const tick = (): void => setState((s) => stepStrip(s, count, width));
    if (schedule) return schedule(tick, STRIP_TICK_MS);
    const handle = setInterval(tick, STRIP_TICK_MS);
    return () => clearInterval(handle);
  }, [animate, count, width, schedule]);

  if (width < MIN_STRIP_WIDTH) return null;
  const rows = renderStrip(state.width === width ? state : { ...state, width });
  return (
    <Box
      flexDirection="column"
      height={STRIP_ROWS}
      width={width}
      overflow="hidden"
    >
      {rows.map((row, i) => (
        <Box key={i} height={1}>
          {runsOf(row).map((run, j) => (
            <Text
              key={j}
              {...(run.fg !== undefined ? { color: run.fg } : {})}
              {...(run.bg !== undefined ? { backgroundColor: run.bg } : {})}
            >
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
