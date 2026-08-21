import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MENU_LEADER_LABEL } from "../menu/menu-keys.js";
import { applyNavSlot, decideApproval } from "../app-key-bindings.js";
import {
  MouseTarget,
  useMouseCommands,
  type MouseContextValue,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { cycleNavSlot } from "../section.js";
import { hasShiftEnterNewline } from "../shift-enter-support.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

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

interface HotkeyChip {
  readonly key: string;
  readonly label: string;
  /**
   * Position in the shedding queue when the row does not fit `width`:
   * chip `1` is dropped first, then `2`, and so on. A chip with no rank
   * is essential — it stays even if the row still overflows (and is then
   * clipped by `truncate-end` rather than wrapped).
   */
  readonly shed?: number;

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

function resolveChips(
  state: TuiState,
  ctrlCArmed: boolean,
  menuLeaderArmed: boolean,
): HotkeyChip[] {
  const hasDraft = state.inputValue.length > 0;
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
    // Esc has exactly one meaning during a turn — abort — because abort
    // deliberately wins over clear-draft (`handleAppKey` claims the key;
    // see `onEscape` in `tui-app.tsx`). Say so when a draft exists: an
    // operator who typed while the agent worked otherwise has nothing on
    // screen telling him whether Esc also eats what he typed. The editor
    // stays live during a run, so the strip also advertises what Enter
    // does now — and how many messages are already parked behind the
    // turn. Scroll sheds first (the wheel already does it), then the
    // parked counter, then the Enter hint.
    // An armed Ctrl+C is the one state where a mispress quits the whole
    // app — it takes the row for itself so nothing dilutes the warning.
    if (ctrlCArmed) {
      return [{ key: "ctrl+c", label: "press again to quit" }];
    }
    const steering = state.whileBusyMode === "steer";
    const chips: HotkeyChip[] = [
      { key: SCROLL_KEY, label: "scroll", shed: 1 },
      { key: "⏎", label: steering ? "steer" : "queue message", shed: 3 },
      {
        key: "ctrl+t",
        label: steering ? "queue mode" : "steer mode",
        shed: 4,
      },
      { key: "esc", label: hasDraft ? "abort, draft kept" : "abort" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "abort",
      },
    ];
    if (state.queuedMessages.length > 0) {
      chips.push({
        key: "/queue",
        label: `${state.queuedMessages.length} parked`,
        shed: 2,
      });
    }
    return chips;
  }
  if (state.uiMode === "debug") {
    // Ctrl+B still cycles panels but is unadvertised: it duplicated the
    // Tab chip word-for-word, and the freed slot pays for the one hint
    // panels actually lacked — the way back to Run. Shift+Tab sheds
    // first because "prev panel" is guessable from "next panel".
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
        shed: 1,
        onClick: (mouse) =>
          applyNavSlot(mouse.dispatch, cycleNavSlot(mouse.getState(), -1)),
      },
      {
        key: "esc",
        label: "back to Run",
        onClick: (mouse) => mouse.dispatch({ type: "ui_mode_set", mode: "chat" }),
      },
      { key: "ctrl+p", label: "menu", shed: 2 },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "quit",
      },
    ];
  }
  if (state.chatFocus === "sidebar") {
    return [
      { key: "↑↓", label: "select", shed: 2 },
      { key: "enter", label: "open" },
      { key: "tab", label: "next pane", shed: 1 },
      { key: "esc", label: "back to editor" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "quit",
      },
    ];
  }
  // The strip fits one row by shedding, not by a fixed cap. `ctrl+p`
  // holds the slot `/` used to: the menu contains every slash command
  // as well as every destination, and `/` keeps working for anyone who
  // already reaches for it. Shedding order: scroll (the wheel already
  // does it), then the sidebar (narrow terminals collapse it anyway —
  // see `SIDEBAR_MIN_COLUMNS`), then the newline key, then the menu
  // chip. A draft adds an `esc / clear draft` chip so the affordance is
  // on screen exactly when it applies — `/` no longer opens the palette
  // with a non-empty buffer, so nothing usable is displaced.
  return [
    { key: "enter", label: "send" },
    // Shift+Enter only exists as a keystroke where the terminal speaks
    // the kitty keyboard protocol; everywhere else it is byte-identical
    // to Enter and would submit. Alt+Enter works in both worlds, so it
    // is what the strip promises when the protocol is absent.
    {
      key: hasShiftEnterNewline() ? "shift+enter" : "alt+enter",
      label: "newline",
      shed: 3,
    },
    {
      key: "tab",
      label: "sidebar",
      shed: 2,
      onClick: (mouse) =>
        mouse.dispatch({ type: "chat_focus_set", focus: "sidebar" }),
    },
    { key: SCROLL_KEY, label: "scroll", shed: 1 },
    // Esc opens the menu only on an empty buffer — with a draft it
    // clears the draft — so the strip advertises whichever one the next
    // press will actually do.
    ...(hasDraft
      ? [{ key: "esc", label: "clear draft" }]
      : [{ key: "esc", label: "menu", shed: 5 }]),
    { key: "ctrl+p", label: "menu", shed: 4 },
    {
      key: "ctrl+c",
      label: ctrlCArmed ? "press again to quit" : "quit",
    },
  ];
}

/**
 * Drop chips — lowest `shed` rank first — until the row fits `width`.
 * Stops once only essential (rank-less) chips remain; those overflow
 * into `truncate-end` rather than silently disappearing.
 */
function fitChips(chips: HotkeyChip[], width: number): HotkeyChip[] {
  let kept = chips;
  while (stripWidth(kept) > width) {
    const next = nextToShed(kept);
    if (next < 0) break;
    kept = kept.filter((_, idx) => idx !== next);
  }
  return kept;
}

function nextToShed(chips: readonly HotkeyChip[]): number {
  let best = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  chips.forEach((chip, idx) => {
    if (chip.shed === undefined || chip.shed >= bestRank) return;
    best = idx;
    bestRank = chip.shed;
  });
  return best;
}

/**
 * Rendered columns of the whole strip. Every key and label we ship is
 * single-width (ASCII plus `↑`, `↓`, `·`), so `String.length` is the
 * rendered width and we do not need a `string-width` dependency here —
 * keep new chips inside that alphabet.
 */
function stripWidth(chips: readonly HotkeyChip[]): number {
  if (chips.length === 0) return 0;
  const separator = 4 + theme.glyphs.dotSeparator.length;
  const chipWidths = chips.reduce(
    // "[" + key + "] " + label
    (acc, chip) => acc + chip.key.length + chip.label.length + 3,
    0,
  );
  return chipWidths + (chips.length - 1) * separator;
}
