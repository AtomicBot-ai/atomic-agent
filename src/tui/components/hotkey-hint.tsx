import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface HotkeyHintProps {
  state: TuiState;
  /** Whether a Ctrl+C was recently pressed and is armed for exit. */
  ctrlCArmed?: boolean;
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
  width,
}: HotkeyHintProps): ReactElement {
  const chips = fitChips(resolveChips(state, ctrlCArmed ?? false), width);
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
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
      </Text>
    </Box>
  );
}

function resolveChips(state: TuiState, ctrlCArmed: boolean): HotkeyChip[] {
  const hasDraft = state.inputValue.length > 0;
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
    // Esc has exactly one meaning during a turn — abort — because abort
    // deliberately wins over clear-draft (see `onEscape` in
    // `tui-app.tsx`). Say so when a draft exists: an operator who typed
    // while the agent worked otherwise has nothing on screen telling him
    // whether Esc also eats what he typed. A long streaming answer is
    // also exactly when he wants to scroll back, so that hint rides
    // along until the row runs out of room.
    return [
      { key: SCROLL_KEY, label: "scroll", shed: 1 },
      { key: "esc", label: hasDraft ? "abort, draft kept" : "abort" },
      {
        key: "ctrl+c",
        label: ctrlCArmed ? "press again to quit" : "abort",
      },
    ];
  }
  if (state.uiMode === "debug") {
    // Ctrl+B still cycles panels but is unadvertised: it duplicated the
    // Tab chip word-for-word, and the freed slot pays for the one hint
    // panels actually lacked — the way back to Run. Shift+Tab sheds
    // first because "prev panel" is guessable from "next panel".
    return [
      { key: "tab", label: "next panel" },
      { key: "shift+tab", label: "prev panel", shed: 1 },
      { key: "esc", label: "back to Run" },
      { key: "/", label: "commands", shed: 2 },
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
  // Six chips is the cap for one row on a wide terminal. The scroll
  // hint replaces ctrl+b: Observe stays reachable via /observe, while
  // scrolling had no visible entry point at all. Shedding order: scroll
  // (the wheel already does it), then the sidebar (which the same
  // narrow terminals collapse anyway — see `SIDEBAR_MIN_COLUMNS`), then
  // the newline key.
  return [
    { key: "enter", label: "send" },
    { key: "alt+enter", label: "newline", shed: 3 },
    { key: "tab", label: "sidebar", shed: 2 },
    { key: SCROLL_KEY, label: "scroll", shed: 1 },
    // A draft **swaps** the `/` chip instead of adding a seventh one:
    // with a non-empty buffer `/` no longer opens the palette
    // (`slashPrefix` only fires on a leading slash), so the chip being
    // replaced is inert in exactly the state that needs the new one.
    hasDraft
      ? { key: "esc", label: "clear draft" }
      : { key: "/", label: "commands" },
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
