import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface HotkeyHintProps {
  state: TuiState;
  /** Whether a Ctrl+C was recently pressed and is armed for exit. */
  ctrlCArmed?: boolean;
}

interface HotkeyChip {
  readonly key: string;
  readonly label: string;
}

/** Terminal mouse tracking is on — hold Shift to drag-select or click OSC8 links. */
const SHIFT_SELECT_CHIP: HotkeyChip = { key: "shift", label: "select" };

function withShiftSelect(chips: readonly HotkeyChip[]): HotkeyChip[] {
  return [...chips, SHIFT_SELECT_CHIP];
}

/**
 * Bottom hint strip: surfaces the keybindings that are meaningful in
 * the current state so the user never has to guess. We cap to ~6 chips
 * to fit one terminal row and let slash commands take care of the long
 * tail.
 */
export function HotkeyHint({ state, ctrlCArmed }: HotkeyHintProps): ReactElement {
  const chips = resolveChips(state, ctrlCArmed ?? false);
  return (
    <Box flexShrink={0}>
      {chips.map((chip, idx) => (
        <Text key={chip.key}>
          <Text color={theme.colors.accentSoft} bold>
            [{chip.key}]
          </Text>
          <Text color={theme.colors.muted}> {chip.label}</Text>
          {idx < chips.length - 1 ? (
            <Text color={theme.colors.muted}>
              {"  "}
              {theme.glyphs.dotSeparator}
              {"  "}
            </Text>
          ) : null}
        </Text>
      ))}
    </Box>
  );
}

function resolveChips(state: TuiState, ctrlCArmed: boolean): HotkeyChip[] {
  if (state.pendingApproval) {
    return [
      { key: "y", label: "approve" },
      { key: "n", label: "deny" },
      { key: "esc", label: "abort run" },
    ];
  }
  if (state.slashPaletteOpen) {
    return [
      { key: "↑↓", label: "select" },
      { key: "tab/enter", label: "accept" },
      { key: "esc", label: "close" },
    ];
  }
  if (state.status === "running") {
    return withShiftSelect([
      { key: "esc", label: "abort" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "abort",
      },
    ]);
  }
  if (state.uiMode === "debug") {
    return withShiftSelect([
      { key: "tab", label: "next panel" },
      { key: "shift+tab", label: "prev panel" },
      { key: "ctrl+b", label: "next panel" },
      { key: "/", label: "commands" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "quit",
      },
    ]);
  }
  if (state.chatFocus === "sidebar") {
    return withShiftSelect([
      { key: "↑↓", label: "select" },
      { key: "enter", label: "open" },
      { key: "tab", label: "next pane" },
      { key: "esc", label: "back to editor" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "quit",
      },
    ]);
  }
  return withShiftSelect([
    { key: "enter", label: "send" },
    { key: "alt+enter", label: "newline" },
    { key: "tab", label: "sidebar" },
    { key: "ctrl+b", label: "open Observe" },
    { key: "/", label: "commands" },
    {
      key: "ctrl+c",
      label: ctrlCArmed ? "press again to quit" : "quit",
    },
  ]);
}
