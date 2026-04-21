import type { TuiTab } from "./tui-state.js";

export interface HotkeyLegend {
  key: string;
  label: string;
}

/** Shown when no run is active — the input field expects the next message. */
export const IDLE_HOTKEYS: readonly HotkeyLegend[] = [
  { key: "enter", label: "send message" },
  { key: "tab", label: "next tab" },
  { key: "ctrl+c", label: "quit" },
  { key: "esc", label: "quit" },
];

/** Shown while the agent is running — Enter is inert, Esc aborts. */
export const RUNNING_HOTKEYS: readonly HotkeyLegend[] = [
  { key: "esc", label: "abort run" },
  { key: "tab", label: "next tab" },
  { key: "ctrl+c", label: "quit" },
];

export const APPROVAL_HOTKEYS: readonly HotkeyLegend[] = [
  { key: "y", label: "approve" },
  { key: "n", label: "deny" },
  { key: "esc", label: "abort run" },
];

const TAB_ORDER: readonly TuiTab[] = [
  "chat",
  "feed",
  "world",
  "reasoning",
  "logs",
];

export function cycleTab(current: TuiTab, direction: 1 | -1 = 1): TuiTab {
  const currentIndex = TAB_ORDER.indexOf(current);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex =
    (safeIndex + direction + TAB_ORDER.length) % TAB_ORDER.length;
  return TAB_ORDER[nextIndex] ?? "chat";
}
