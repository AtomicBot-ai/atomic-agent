import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { buildAtomRows } from "../onboarding/atom-field-rows.js";
import type { AtomFieldState } from "../onboarding/atom-field.js";
import { theme } from "../theme/theme.js";

/**
 * The colour two atoms turn when they touch. Deliberately not a theme
 * token and deliberately outside every palette: the design asks for one
 * jolt of toxic green in an otherwise muted pane, and no palette owns a
 * colour whose whole job is to not belong. It is never used for state,
 * so it carries no meaning a themed colour would have to preserve. The
 * colour is emphasis only — the collision's load-bearing signal is the
 * glyph swap in `atom-field-rows.ts`, which survives NO_COLOR.
 */
export const ATOM_COLLISION_COLOR = "#39ff14";

/**
 * The atoms, drawn into the rows the caller has reserved for them.
 *
 * Exactly as many `<Text>` rows as the field is tall, and the Box is
 * pinned to that height: Ink 7 overlaps rather than clips, so a field
 * that grew by one row would paint over the progress bars above it
 * rather than being cropped.
 *
 * The resting colour is `border`, the dimmest token there is. This is
 * the least important thing on the screen and has to read that way next
 * to a progress bar the operator is actually waiting on.
 */
export function OnboardingAtomField(props: {
  field: AtomFieldState;
  columns: number;
  rows: number;
}): ReactElement {
  const rows = buildAtomRows(props.field, {
    columns: props.columns,
    rows: props.rows,
  });
  return (
    <Box flexDirection="column" flexShrink={0} height={rows.length}>
      {rows.map((runs, rowIndex) => (
        <Text key={rowIndex} wrap="truncate">
          {runs.length === 0
            ? " "
            : runs.map((run, runIndex) => (
                <Text
                  key={runIndex}
                  color={run.hot ? ATOM_COLLISION_COLOR : theme.colors.border}
                >
                  {run.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
