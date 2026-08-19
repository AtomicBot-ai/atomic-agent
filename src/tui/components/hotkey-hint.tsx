import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MENU_LEADER_LABEL } from "../menu/menu-keys.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface HotkeyHintProps {
  state: TuiState;
  /** Whether a Ctrl+C was recently pressed and is armed for exit. */
  ctrlCArmed?: boolean;
  /** Whether a `ctrl+g` leader is waiting for its chord key. */
  menuLeaderArmed?: boolean;
}

interface HotkeyChip {
  readonly key: string;
  readonly label: string;
}

/**
 * Platform-aware label for the chat-scroll key. The physical key is
 * PageUp; Mac keyboards reach it via Fn+Up, and that is the spelling
 * Mac users actually recognise.
 */
const SCROLL_KEY = process.platform === "darwin" ? "fn+\u2191\u2193" : "pgup/pgdn";

/**
 * Bottom hint strip: surfaces the keybindings that are meaningful in
 * the current state so the user never has to guess. We cap to ~6 chips
 * to fit one terminal row and let slash commands take care of the long
 * tail.
 */
export function HotkeyHint({
  state,
  ctrlCArmed,
  menuLeaderArmed,
}: HotkeyHintProps): ReactElement {
  const chips = resolveChips(state, ctrlCArmed ?? false, menuLeaderArmed ?? false);
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

function resolveChips(
  state: TuiState,
  ctrlCArmed: boolean,
  menuLeaderArmed: boolean,
): HotkeyChip[] {
  if (state.pendingApproval) {
    return [
      { key: "y", label: "approve" },
      { key: "n", label: "deny" },
      { key: "esc", label: "abort run" },
    ];
  }
  // An armed leader owns the very next keystroke and unfocuses the editor
  // while it waits, so it takes the whole strip: the row the operator is
  // already looking at is where "the app is mid-gesture" belongs. Ordered
  // to match key precedence — a pending approval still outranks it.
  if (menuLeaderArmed) {
    return [
      { key: MENU_LEADER_LABEL, label: "waiting for a chord" },
      { key: "ctrl+p", label: "full menu" },
      { key: "esc", label: "cancel" },
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
    // A long streaming answer is exactly when the operator wants to
    // scroll back, so the hint rides along with abort.
    return [
      { key: SCROLL_KEY, label: "scroll" },
      { key: "esc", label: "abort" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "abort",
      },
    ];
  }
  if (state.uiMode === "debug") {
    // Ctrl+B still cycles panels but is unadvertised: it duplicated the
    // Tab chip word-for-word, and the freed slot pays for the one hint
    // panels actually lacked — the way back to Run.
    return [
      { key: "tab", label: "next panel" },
      { key: "shift+tab", label: "prev panel" },
      { key: "esc", label: "back to Run" },
      { key: "ctrl+p", label: "menu" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "quit",
      },
    ];
  }
  if (state.chatFocus === "sidebar") {
    return [
      { key: "↑↓", label: "select" },
      { key: "enter", label: "open" },
      { key: "tab", label: "next pane" },
      { key: "esc", label: "back to editor" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "quit",
      },
    ];
  }
  // Six chips is the cap for one row on narrow terminals. `ctrl+p` takes
  // the slot `/` used to hold: the menu contains every slash command as
  // well as every destination, so advertising the superset costs nothing
  // and `/` keeps working for anyone who already reaches for it.
  return [
    { key: "enter", label: "send" },
    { key: "alt+enter", label: "newline" },
    { key: "tab", label: "sidebar" },
    { key: SCROLL_KEY, label: "scroll" },
    { key: "ctrl+p", label: "menu" },
    {
      key: "ctrl+c",
      label: ctrlCArmed ? "press again to quit" : "quit",
    },
  ];
}
