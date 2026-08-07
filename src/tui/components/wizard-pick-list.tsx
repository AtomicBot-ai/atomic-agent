import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * Viewport height for every wizard pick list, and the jump distance for
 * PgUp/PgDn in `providers-wizard-key-bindings`. Keep the two in sync by
 * importing this constant, never by copying the number.
 */
export const PICK_WINDOW = 12;

/**
 * Bordered option list windowed around the cursor.
 *
 * Windowing lives here, not in the callers: the live OpenRouter/aimlapi
 * catalogs run past 300 rows, and an unwindowed map would paint them all
 * into the terminal at once.
 *
 * The hint line always starts with the movement keys and the position
 * counter (`j/k move (5/30) · ...`), for short lists too, matching the
 * original CompatChatModelStep shape. The counter is how the operator
 * knows where they are in a list the viewport cannot show whole, and a
 * counter that appears only past a size threshold reads as a glitch.
 */
export function renderPickList(props: {
  title: string;
  options: readonly { label: string }[];
  cursor: number;
  /** Movement-keys part of the hint, e.g. "j/k move". */
  moveHint: string;
  /** Actions part of the hint, e.g. "Enter select · Esc cancel". */
  actionsHint: string;
}): ReactElement {
  const total = props.options.length;
  const clamped = Math.min(Math.max(props.cursor, 0), Math.max(0, total - 1));
  const start = Math.min(
    Math.max(0, clamped - Math.floor(PICK_WINDOW / 2)),
    Math.max(0, total - PICK_WINDOW),
  );
  const visible = props.options.slice(start, start + PICK_WINDOW);
  const position = total === 0 ? "(0/0)" : `(${clamped + 1}/${total})`;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accentSoft}>
        {props.title}
      </Text>
      {visible.map((opt, i) => {
        const index = start + i;
        const mark = index === clamped ? ">" : " ";
        return (
          <Text
            key={`${index}-${opt.label}`}
            color={index === clamped ? theme.colors.accentSoft : undefined}
          >
            {mark} {opt.label}
          </Text>
        );
      })}
      <Text color={theme.colors.muted}>
        {props.moveHint} {position} · {props.actionsHint}
      </Text>
    </Box>
  );
}
