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

/**
 * Bottom hint strip: surfaces the keybindings that are meaningful in
 * the current state so the user never has to guess. We cap to ~6 chips
 * to fit one terminal row and let slash commands take care of the long
 * tail.
 */
export function HotkeyHint({ state, ctrlCArmed }: HotkeyHintProps): ReactElement {
  const chips = resolveChips(state, ctrlCArmed ?? false);
  return (
    <Box>
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
    return [
      { key: "esc", label: "abort" },
      { key: "f2", label: state.uiMode === "chat" ? "debug" : "chat" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "abort",
      },
    ];
  }
  return [
    { key: "enter", label: "send" },
    { key: "alt+enter", label: "newline" },
    { key: "↑↓", label: "history" },
    { key: "/", label: "commands" },
    { key: "f2", label: state.uiMode === "chat" ? "debug" : "chat" },
    {
      key: "ctrl+c",
      label: ctrlCArmed ? "press again to quit" : "quit",
    },
  ];
}
