import type { TuiState, TuiTab } from "./tui-state.js";

/**
 * Operator-dashboard section. The TUI groups its many surfaces into
 * three top-level zones so the chrome stays minimal and the operator's
 * attention is not split across nine peer tabs:
 *
 * - `run`     — chat and the live turn (default).
 * - `observe` — diagnostics: feed, world, reasoning, logs, llm-logs.
 * - `manage`  — operator tools: tasks, skills, models, telegram.
 *
 * The section is **derived** from `uiMode` + `activeTab` rather than
 * stored separately. Keeping the underlying action surface unchanged
 * means existing slash commands (`/feed`, `/logs`, `/tasks`, …) and the
 * persisted `initialLayout` contract from `tui-command.ts` keep working
 * without migration.
 */
export type TuiSection = "run" | "observe" | "manage";

/** Inner tabs of the Observe section, in display + cycle order. */
export const OBSERVE_TABS: readonly TuiTab[] = [
  "feed",
  "world",
  "reasoning",
  "logs",
  "llm-logs",
];

/** Inner tabs of the Manage section, in display + cycle order. */
export const MANAGE_TABS: readonly TuiTab[] = [
  "tasks",
  "skills",
  "models",
  "telegram",
];

/** Canonical top-level section ordering for status bar / cycling. */
export const SECTION_ORDER: readonly TuiSection[] = [
  "run",
  "observe",
  "manage",
];

/** Project the underlying ui mode + active tab onto a section. */
export function getCurrentSection(state: TuiState): TuiSection {
  if (state.uiMode === "chat") return "run";
  if (isManageTab(state.activeTab)) return "manage";
  return "observe";
}

/** Default landing tab when an operator jumps to a section by name. */
export function getDefaultTabForSection(section: TuiSection): TuiTab {
  if (section === "manage") return MANAGE_TABS[0]!;
  return OBSERVE_TABS[0]!;
}

/**
 * Cycle to the next sub-tab inside the active section. Returns `null`
 * for the `run` section (no inner tabs) so the caller can fall through
 * to the next handler instead of consuming the keypress.
 */
export function cycleSubTab(
  state: TuiState,
  direction: 1 | -1,
): TuiTab | null {
  const section = getCurrentSection(state);
  if (section === "run") return null;
  const tabs = section === "manage" ? MANAGE_TABS : OBSERVE_TABS;
  const idx = tabs.indexOf(state.activeTab);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + direction + tabs.length) % tabs.length;
  return tabs[next] ?? tabs[0] ?? null;
}

/**
 * Operator-visible "navigation slot" — what one Tab press should move
 * to next when cycling globally across the dashboard. The `run` slot
 * stands in for the chat surface (no inner tab); every other slot is a
 * concrete debug tab inside Observe or Manage.
 */
export type NavSlot =
  | { kind: "run" }
  | { kind: "debug-tab"; tab: TuiTab };

/**
 * Linear ordering of nav slots used by global Tab cycling: chat → all
 * Observe sub-tabs in order → all Manage sub-tabs in order → back to
 * chat. Keeping this list flat (rather than a tree of "section then
 * sub-tab") makes Shift+Tab the strict inverse of Tab and avoids the
 * "Tab does nothing" trap on the chat screen the operator hit on the
 * first iteration of this dashboard.
 */
export const NAV_SLOT_ORDER: readonly NavSlot[] = [
  { kind: "run" },
  ...OBSERVE_TABS.map<NavSlot>((tab) => ({ kind: "debug-tab", tab })),
  ...MANAGE_TABS.map<NavSlot>((tab) => ({ kind: "debug-tab", tab })),
];

/** Project the current TUI state onto its corresponding nav slot. */
export function getCurrentNavSlot(state: TuiState): NavSlot {
  if (state.uiMode === "chat") return { kind: "run" };
  return { kind: "debug-tab", tab: state.activeTab };
}

/**
 * Cycle to the next / previous nav slot regardless of section. Used by
 * Tab / Shift+Tab in both chat and debug modes, so the operator has a
 * single key to walk every dashboard surface in order.
 */
export function cycleNavSlot(
  state: TuiState,
  direction: 1 | -1,
): NavSlot {
  const current = getCurrentNavSlot(state);
  const idx = NAV_SLOT_ORDER.findIndex((slot) => navSlotEquals(slot, current));
  const safe = idx === -1 ? 0 : idx;
  const len = NAV_SLOT_ORDER.length;
  const nextIdx = (safe + direction + len) % len;
  return NAV_SLOT_ORDER[nextIdx]!;
}

function navSlotEquals(a: NavSlot, b: NavSlot): boolean {
  if (a.kind === "run" && b.kind === "run") return true;
  if (a.kind === "debug-tab" && b.kind === "debug-tab") return a.tab === b.tab;
  return false;
}

function isManageTab(tab: TuiTab): boolean {
  return (MANAGE_TABS as readonly string[]).includes(tab);
}
