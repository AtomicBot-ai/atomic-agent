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
      <Box borderStyle="round" borderColor={theme.colors.warn} paddingX={1}>
        <Text color={theme.colors.warn}>no matching command</Text>
      </Box>
    );
  }
  const visible = completions.slice(0, MAX_ROWS);
  const cursor = Math.max(0, Math.min(props.cursor, visible.length - 1));
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
    >
      {visible.map((cmd, idx) => (
        <PaletteRow
          key={cmd.name}
          command={cmd}
          selected={idx === cursor}
        />
      ))}
      {completions.length > visible.length ? (
        <Text color={theme.colors.muted}>
          …{completions.length - visible.length} more
        </Text>
      ) : null}
    </Box>
  );
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
