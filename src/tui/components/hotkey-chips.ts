import { MENU_LEADER_LABEL } from "../menu/menu-keys.js";
import {
  APPROVAL_CHORDS,
  PLAN_CHORDS,
  applyNavSlot,
  decideApproval,
} from "../app-key-bindings.js";
import type { MouseContextValue } from "../mouse/mouse-context.js";
import { cycleNavSlot } from "../section.js";
import { hasShiftEnterNewline } from "../shift-enter-support.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

/**
 * The hint strip's chip model: which chips the current state earns and
 * which of them survive a narrow row. Split from `hotkey-hint.tsx` so
 * the strip's policy (this file) and its rendering (that one) each stay
 * a readable size — the policy is where every new chip lands.
 */
export interface HotkeyChip {
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
 * A live composer selection flips what Ctrl+C will actually do (copy,
 * not abort/quit — see `composerOwnsCtrlC` in app-key-bindings) and
 * gives Ctrl+X a meaning (cut). The strip must say so, but only while
 * the editor really has the keyboard: the selection flag survives Tab
 * into the sidebar and an open menu/panel, where Ctrl+C keeps its
 * global meaning.
 */
function composerSelectionActive(state: TuiState): boolean {
  return (
    state.composerHasSelection &&
    state.chatFocus === "editor" &&
    !state.menuOpen &&
    !state.contextPanelOpen
  );
}


export function resolveChips(
  state: TuiState,
  ctrlCArmed: boolean,
  menuLeaderArmed: boolean,
): HotkeyChip[] {
  const hasDraft = state.inputValue.length > 0;
  if (state.pendingApproval) {
    const approval = state.pendingApproval;
    // The chords, not the bare letters. The chat composer stays live
    // while a prompt is up, so `approvalHotkey` only answers to a
    // *modified* key — a bare `y` is text and lands in the draft. This
    // strip used to advertise `y` / `n`, which meant the two things on
    // screen telling the operator how to answer disagreed, and the one
    // in the larger type was the one that did nothing. `n` was wrong on
    // both counts: deny is `d`, because `n` is one keystroke from the
    // newline the editor below is still listening for.
    return [
      {
        key: `ctrl+${APPROVAL_CHORDS.approve}`,
        label: "approve",
        onClick: (mouse) => decideApproval(approval, true, mouse),
      },
      {
        key: `ctrl+${APPROVAL_CHORDS.deny}`,
        label: "deny",
        onClick: (mouse) => decideApproval(approval, false, mouse),
      },
      { key: "esc", label: "abort run" },
    ];
  }
  // The plan hand-off, same shape as the approval strip above and for
  // the same reason: the buttons under the plan are drawn once, in the
  // transcript, and scroll away with it, while this row stays put. It
  // is also the only place the chords are written down — the buttons
  // carry their full labels and adding `· ctrl+y` to each one pushed
  // the third button onto a second line at 92 columns.
  if (state.planHandoff) {
    return [
      { key: `ctrl+${PLAN_CHORDS.auto}`, label: "run it · auto" },
      { key: `ctrl+${PLAN_CHORDS.bypass}`, label: "run it · bypass", shed: 2 },
      { key: `ctrl+${PLAN_CHORDS.dismiss}`, label: "dismiss plan", shed: 1 },
      { key: "esc", label: "menu" },
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
      ...(composerSelectionActive(state)
        ? [
            { key: "ctrl+x", label: "cut", shed: 5 },
            { key: "ctrl+c", label: "copy" },
          ]
        : [
            {
              key: "ctrl+c",
              label: ctrlCArmed ? "press again to quit" : "abort",
            },
          ]),
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
  // see `SIDEBAR_MIN_COLUMNS`), then the route chip (the route line
  // itself is clickable, so the keyboard hint is the first luxury),
  // then the new-window chip (a convenience the menu also carries as
  // `/window`), then the newline key, then the menu chip. A draft adds
  // an `esc / clear draft` chip so the affordance is on screen exactly
  // when it applies — `/` no longer opens the palette with a non-empty
  // buffer, so nothing usable is displaced.
  return [
    { key: "enter", label: "send" },
    // Shift+Enter only exists as a keystroke where the terminal speaks
    // the kitty keyboard protocol; everywhere else it is byte-identical
    // to Enter and would submit. Alt+Enter works in both worlds, so it
    // is what the strip promises when the protocol is absent.
    {
      key: hasShiftEnterNewline() ? "shift+enter" : "alt+enter",
      label: "newline",
      shed: 5,
    },
    {
      key: "tab",
      label: "sidebar",
      shed: 2,
      onClick: (mouse) =>
        mouse.dispatch({ type: "chat_focus_set", focus: "sidebar" }),
    },
    { key: SCROLL_KEY, label: "scroll", shed: 1 },
    // The composer's three route controls: the only keyboard way in,
    // and until this chip the only place it was written down was the
    // popup it opens.
    {
      key: "ctrl+r",
      label: "route",
      shed: 3,
      onClick: (mouse) =>
        mouse.dispatch({ type: "composer_switch_opened", kind: "backend" }),
    },
    // A fresh OS terminal window running another atomic-agent in the
    // same working dir (`/window` is the slash spelling). This strip is
    // the only place the key is written down, but it is still a luxury
    // next to the editor basics — it sheds right after the chips whose
    // function survives on screen without them, and before newline.
    {
      key: "ctrl+n",
      label: "new window",
      shed: 4,
      onClick: (mouse) => mouse.callbacks.onNewWindowRequested?.(),
    },
    // Esc opens the menu only on an empty buffer — with a draft it
    // clears the draft — so the strip advertises whichever one the next
    // press will actually do.
    ...(hasDraft
      ? [{ key: "esc", label: "clear draft" }]
      : [{ key: "esc", label: "menu", shed: 7 }]),
    { key: "ctrl+p", label: "menu", shed: 6 },
    // A selection can only exist over a non-empty buffer, so the
    // clear-draft Esc chip is always alongside these two.
    ...(composerSelectionActive(state)
      ? [
          { key: "ctrl+x", label: "cut" },
          { key: "ctrl+c", label: "copy" },
        ]
      : [
          {
            key: "ctrl+c",
            label: ctrlCArmed ? "press again to quit" : "quit",
          },
        ]),
  ];
}

/**
 * Drop chips — lowest `shed` rank first — until the row fits `width`.
 * Stops once only essential (rank-less) chips remain; those overflow
 * into `truncate-end` rather than silently disappearing.
 */
export function fitChips(chips: HotkeyChip[], width: number): HotkeyChip[] {
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
