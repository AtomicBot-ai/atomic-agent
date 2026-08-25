import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
} from "../layout.js";
import { theme } from "../theme/theme.js";

/**
 * What the app draws when the window cannot hold it.
 *
 * Ink 7 does not clip a frame taller than the terminal — it overlaps
 * earlier lines. So the failure mode below the floor was never "a
 * cramped UI": it was two UIs painted over each other, with the
 * composer somewhere inside the transcript and the status bar written
 * across the middle of a tool card. There is no arrangement of the real
 * screen that survives eight rows, and pretending otherwise is what
 * produced the garble.
 *
 * So this replaces the app rather than shrinking it, and it has exactly
 * one job: fit anything, and say the two numbers that let someone act —
 * what is needed, and what they have.
 *
 * **It must never overflow, at any size.** That is the whole point, and
 * it is why this component owns its own degradation ladder instead of
 * borrowing the app's: a "terminal too small" card that itself garbles
 * a 20×4 window would be the funniest possible bug. Four tiers, each
 * dropping the least useful line first:
 *
 *   >= 4 rows   title, blank, needs, have
 *   3 rows      title, needs, have
 *   2 rows      title, needs
 *   1 row       the numbers alone — `40x16 needed`
 *
 * and every line is truncated to the width on the way out.
 */
export function TerminalTooSmall({
  columns,
  rows,
}: {
  columns: number;
  rows: number;
}): ReactElement {
  const need = `${MIN_TERMINAL_COLUMNS}x${MIN_TERMINAL_ROWS}`;
  const have = `${columns}x${rows}`;
  const lines = planLines(rows, need, have);
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text
          key={idx}
          color={idx === 0 ? theme.colors.warn : theme.colors.muted}
          bold={idx === 0}
          wrap="truncate"
        >
          {fit(line, columns)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * The ladder. Exported so the fit test can walk it without rendering,
 * and so the tiers are a value rather than a shape buried in JSX.
 */
export function planLines(
  rows: number,
  need: string,
  have: string,
): readonly string[] {
  const title = "terminal too small";
  if (rows >= 4) return [title, "", `needs ${need}`, `this one is ${have}`];
  if (rows === 3) return [title, `needs ${need}`, `this one is ${have}`];
  if (rows === 2) return [title, `needs ${need}`];
  // One row, and the title is the least useful thing on it: somebody
  // looking at a single line of an app that has visibly stopped working
  // already knows something is wrong. The number is the part they cannot
  // guess.
  return [`${need} needed`];
}

/**
 * Truncate rather than wrap. A wrapped line would take a row the ladder
 * above has already spent, and put the card back over the edge it exists
 * to stay inside.
 */
function fit(line: string, columns: number): string {
  const width = Math.max(1, columns);
  if (line.length <= width) return line;
  if (width <= 1) return line.slice(0, width);
  return `${line.slice(0, width - 1)}…`;
}
