import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { applyNavSlot, decideApproval } from "../app-key-bindings.js";
import {
  MouseTarget,
  useMouseCommands,
  type MouseContextValue,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { cycleNavSlot } from "../section.js";
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
  /**
   * What a click on this chip does. Only chips with one unambiguous
   * meaning get one — "alt+enter newline" or "↑↓ select" describe a
   * gesture, not a command, so they stay plain text rather than
   * pretending to be buttons.
   */
  readonly onClick?: (mouse: MouseContextValue) => void;
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
export function HotkeyHint({ state, ctrlCArmed }: HotkeyHintProps): ReactElement {
  const chips = resolveChips(state, ctrlCArmed ?? false);
  return (
    <Box flexShrink={0} flexWrap="wrap">
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

/** Opens the slash palette exactly the way typing `/` does. */
/** Click target for the `ctrl+p` chip — the operator menu. */
function openOperatorMenu(mouse: MouseContextValue): void {
  mouse.dispatch({ type: "menu_opened" });
}

function resolveChips(state: TuiState, ctrlCArmed: boolean): HotkeyChip[] {
  if (state.pendingApproval) {
    const approval = state.pendingApproval;
    return [
      {
        key: "y",
        label: "approve",
        onClick: (mouse) => decideApproval(approval, true, mouse),
      },
      {
        key: "n",
        label: "deny",
        onClick: (mouse) => decideApproval(approval, false, mouse),
      },
      { key: "esc", label: "abort run" },
    ];
  }
  if (state.runModePanel.picker) {
    return [
      { key: "↑↓", label: "mode" },
      { key: "←→", label: "share" },
      { key: "0-9", label: "set" },
      { key: "enter", label: "apply" },
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
    // scroll back, so the hint rides along with abort. The editor stays
    // live during a run, so this row also has to say what Enter will do
    // to whatever is being typed, and how to flip it.
    //
    // Labels are terse on purpose: the strip must stay on ONE terminal
    // row at 80 columns. An armed Ctrl+C takes the whole row for itself
    // — at that moment nothing else matters.
    if (ctrlCArmed) {
      return [
        { key: "ctrl+c", label: "press again to quit" },
        { key: "esc", label: "abort" },
      ];
    }
    const chips: HotkeyChip[] = [
      { key: SCROLL_KEY, label: "scroll" },
      { key: "\u23ce", label: state.whileBusyMode },
      {
        key: "ctrl+t",
        label: state.whileBusyMode === "steer" ? "queue" : "steer",
      },
      { key: "esc", label: "abort" },
    ];
    if (state.queuedMessages.length > 0) {
      chips.push({ key: "queued", label: `${state.queuedMessages.length}` });
    }
    return chips;
  }
  if (state.uiMode === "debug") {
    // Ctrl+B still cycles panels but is unadvertised: it duplicated the
    // Tab chip word-for-word, and the freed slot pays for the one hint
    // panels actually lacked — the way back to Run.
    return [
      {
        key: "tab",
        label: "next panel",
        onClick: (mouse) =>
          applyNavSlot(mouse.dispatch, cycleNavSlot(mouse.getState(), 1)),
      },
      {
        key: "shift+tab",
        label: "prev panel",
        onClick: (mouse) =>
          applyNavSlot(mouse.dispatch, cycleNavSlot(mouse.getState(), -1)),
      },
      {
        key: "esc",
        label: "back to Run",
        onClick: (mouse) => mouse.dispatch({ type: "ui_mode_set", mode: "chat" }),
      },
      { key: "ctrl+p", label: "menu", onClick: openOperatorMenu },
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
  // and `/` keeps working for anyone who already reaches for it. ctrl+r
  // (cycle run mode) stays unadvertised for the same reason ctrl+b was —
  // the mode strip above the chat is its visible entry point, and the
  // menu now lists Local / Cloud / Fusion outright.
  return [
    { key: "enter", label: "send" },
    { key: "alt+enter", label: "newline" },
    {
      key: "tab",
      label: "sidebar",
      onClick: (mouse) =>
        mouse.dispatch({ type: "chat_focus_set", focus: "sidebar" }),
    },
    { key: SCROLL_KEY, label: "scroll" },
    { key: "ctrl+p", label: "menu", onClick: openOperatorMenu },
    {
      key: "ctrl+c",
      label: ctrlCArmed ? "press again to quit" : "quit",
    },
  ];
}
