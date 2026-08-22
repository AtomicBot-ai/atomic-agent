import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { fitChips, resolveChips, type HotkeyChip } from "./hotkey-hint-chips.js";

interface HotkeyHintProps {
  state: TuiState;
  /** Whether a Ctrl+C was recently pressed and is armed for exit. */
  ctrlCArmed?: boolean;
  /** Whether a `ctrl+g` leader is waiting for its chord key. */
  menuLeaderArmed?: boolean;
  /**
   * Columns the strip may occupy. This is the **chat column**, not the
   * terminal: the caller subtracts the root gutter and the sidebar,
   * because the strip shares a flex row with them. Required so a new
   * call site cannot forget it and silently reintroduce the wrap.
   */
  width: number;
}

/**
 * Bottom hint strip: surfaces the keybindings that are meaningful in
 * the current state so the user never has to guess.
 *
 * The strip is budgeted to **one row**. Ink does not clip an over-wide
 * row, it wraps it — and a wrapped strip both costs a row the debug
 * pane already budgeted away (`APP_CHROME_ROWS`) and splits chips from
 * their separators into an unreadable two-line smear. So chips are shed
 * in a declared order until the row fits, and `truncate-end` clips the
 * essential remainder on a terminal too narrow even for those.
 */
export function HotkeyHint({
  state,
  ctrlCArmed,
  menuLeaderArmed,
  width,
}: HotkeyHintProps): ReactElement {
  const chips = fitChips(
    resolveChips(state, ctrlCArmed ?? false, menuLeaderArmed ?? false),
    width,
  );
  return (
    <Box flexShrink={0} overflow="hidden">
      {chips.map((chip, idx) => (
        <Box key={chip.key} flexShrink={0}>
          <Chip chip={chip} />
          {idx < chips.length - 1 ? (
            <Text color={theme.colors.muted}>
              {"  "}
              {theme.glyphs.dotSeparator}
              {"  "}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

function Chip({ chip }: { chip: HotkeyChip }): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text>
      <Text color={theme.colors.accentSoft} bold>
        [{chip.key}]
      </Text>
      <Text color={theme.colors.muted}> {chip.label}</Text>
    </Text>
  );
  if (!mouse || !chip.onClick) return label;
  const onClick = chip.onClick;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onClick(mouse);
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}
