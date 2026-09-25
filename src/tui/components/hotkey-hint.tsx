import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { layoutChipRows } from "./hotkey-chip-rows.js";
import { resolveChips, type HotkeyChip } from "./hotkey-chips.js";

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
  /**
   * Rows the strip may spend before it goes back to shedding chips.
   * The window's call, not the strip's — `computeHintRowBudget` in
   * `layout.ts` derives it from the terminal height, and the caller
   * subtracts the same number from the chat viewport. Defaults to 1,
   * which is the old single-row strip exactly.
   */
  maxRows?: number;
}

/**
 * Bottom hint strip: surfaces the keybindings that are meaningful in
 * the current state so the user never has to guess.
 *
 * **It wraps.** The strip used to be budgeted to exactly one row, and it
 * bought that row by *deleting* hints: at 83 columns — what a 120-column
 * terminal leaves the chat column once the rail has taken its share, and
 * therefore the width most operators run — the idle strip had already
 * shed `scroll`, the sidebar key, `ctrl+r route`, `ctrl+n new window`
 * and the text-selection hint. The order of preference is now wrap, then
 * shed, then clip: `layoutChipRows` packs the chips over as many rows as
 * `maxRows` allows, drops them in the declared `shed` order only when
 * the window cannot spare another row, and lets `truncate-end` take the
 * remainder when nothing rankable is left.
 *
 * Each row is its own Box so a chip can never be split from the
 * separator that follows it — Ink would happily wrap mid-chip if the
 * whole strip were one row of items, which is the "unreadable two-line
 * smear" the single-row budget was protecting against.
 */
export function HotkeyHint({
  state,
  ctrlCArmed,
  menuLeaderArmed,
  width,
  maxRows = 1,
}: HotkeyHintProps): ReactElement {
  const rows = layoutChipRows(
    resolveChips(state, ctrlCArmed ?? false, menuLeaderArmed ?? false),
    width,
    maxRows,
  );
  return (
    <Box flexShrink={0} flexDirection="column" overflow="hidden">
      {rows.map((row, rowIdx) => (
        <Box key={rowKey(row, rowIdx)} flexShrink={0}>
          {row.map((chip, idx) => (
            <Box key={chip.key} flexShrink={0}>
              <Chip chip={chip} />
              {idx < row.length - 1 ? (
                <Text color={theme.colors.muted}>
                  {"  "}
                  {theme.glyphs.dotSeparator}
                  {"  "}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/**
 * A row's identity is the keys on it: rows are re-packed on every width
 * change, so keying by index alone would let React reuse a row whose
 * contents moved wholesale to the line above.
 */
function rowKey(row: readonly HotkeyChip[], idx: number): string {
  return `${idx}:${row.map((chip) => chip.key).join("|")}`;
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
