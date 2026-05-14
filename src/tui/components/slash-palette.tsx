import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { filterSlashCommands } from "../commands/slash-commands.js";
import type { SlashCommandDef } from "../commands/slash-commands.js";
import { theme } from "../theme/theme.js";

interface SlashPaletteProps {
  query: string;
  cursor: number;
  /** Optional override for the completions list — used in tests. */
  commands?: readonly SlashCommandDef[];
}

const MAX_ROWS = 6;

/**
 * Overlay-style list of slash-command completions. Rendered just above
 * the editor, narrow width, with a highlighted row for the current
 * cursor. Keyboard handling (Up/Down/Tab/Esc) lives in the app shell —
 * this component is pure presentation.
 */
export function SlashPalette(props: SlashPaletteProps): ReactElement | null {
  const completions = props.commands ?? filterSlashCommands(props.query);
  if (completions.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.colors.warn}
        paddingX={1}
        flexShrink={0}
      >
        <Text color={theme.colors.warn}>no matching command</Text>
      </Box>
    );
  }
  const cursor = Math.max(0, Math.min(props.cursor, completions.length - 1));
  const windowStart = computeWindowStart(cursor, completions.length, MAX_ROWS);
  const visible = completions.slice(windowStart, windowStart + MAX_ROWS);
  const visibleCursor = cursor - windowStart;
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(0, completions.length - windowStart - visible.length);
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {hiddenBefore} above</Text>
      ) : null}
      {visible.map((cmd, idx) => (
        <PaletteRow
          key={cmd.name}
          command={cmd}
          selected={idx === visibleCursor}
        />
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} below</Text>
      ) : null}
    </Box>
  );
}

/**
 * Scroll window that keeps `cursor` in view. Mirrors openclaw's
 * "sticky bottom" behaviour: the window only moves when the cursor would
 * otherwise fall off the visible slice.
 */
function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}

function PaletteRow({
  command,
  selected,
}: {
  command: SlashCommandDef;
  selected: boolean;
}): ReactElement {
  return (
    <Box>
      <Text
        color={selected ? theme.colors.accentSoft : theme.colors.muted}
        bold={selected}
      >
        {selected ? theme.glyphs.chevronRight : " "} /{command.name}
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {command.description}
      </Text>
    </Box>
  );
}

/** Pure helper so the app shell can clamp the cursor consistently. */
export function clampPaletteCursor(
  cursor: number,
  query: string,
  max: number = MAX_ROWS,
): number {
  const completions = filterSlashCommands(query);
  const visibleCount = Math.min(completions.length, max);
  if (visibleCount === 0) return 0;
  return Math.max(0, Math.min(cursor, visibleCount - 1));
}
