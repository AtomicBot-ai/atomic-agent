import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { selectVisibleSkillRows } from "./skills-filter.js";
import {
  HUB_CARD_BODY_WINDOW,
  type SkillSummaryRow,
  type SkillsPanelState,
} from "./skills-panel-state.js";

export interface SkillsTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Skills tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true`
 * when the key was consumed so the caller can suppress the editor
 * echo.
 *
 * Two modes:
 *
 *  - `list`   — `j/k` cursor, `e` toggle, `r` refresh, `f` cycle filter,
 *               `a` toggle auto-refresh, `Enter` open detail.
 *  - `detail` — `Esc` close, `e` toggle the displayed skill, `r` refresh.
 */
export function handleSkillsTabKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "skills") return false;
  const panel = state.skillsPanel;
  // The install-confirm modal claims keys regardless of the underlying
  // mode so a stray hotkey cannot install behind the operator's back.
  if (panel.installConfirm) return handleConfirmKey(input, key, ctx);
  // The uninstall-confirm modal likewise claims keys so a stray hotkey
  // cannot delete a skill directory.
  if (panel.removeConfirm) return handleRemoveConfirmKey(input, key, ctx);
  // The pre-install card claims keys next so list-nav hotkeys do not leak
  // through while the operator is reviewing a skill.
  if (panel.hubCard) return handleHubCardKey(input, key, ctx);
  if (panel.mode === "hub") return handleHubKey(input, key, ctx);
  if (panel.mode === "detail") return handleDetailKey(input, key, ctx);
  return handleListKey(input, key, ctx);
}

function handleListKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const panel = state.skillsPanel;
  if (key.downArrow || input === "j") {
    dispatch({ type: "skills_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "skills_cursor_moved", delta: -1 });
    return true;
  }
  const selected = selectedVisibleRow(panel);
  if (key.return) {
    if (selected) callbacks.onSkillDetailRequested?.(selected.name);
    return true;
  }
  if (input === "e") {
    if (selected) callbacks.onSkillToggleRequested?.(selected.name);
    return true;
  }
  if (input === "r") {
    callbacks.onSkillsRefreshRequested?.();
    return true;
  }
  if (input === "a") {
    dispatch({ type: "skills_auto_refresh_toggled" });
    return true;
  }
  if (input === "f") {
    dispatch({ type: "skills_filter_cycled", direction: 1 });
    return true;
  }
  if (input === "i") {
    callbacks.onSkillHubOpen?.();
    return true;
  }
  if (input === "d") {
    if (selected) callbacks.onSkillRemoveRequested?.(selected.name);
    return true;
  }
  return false;
}

/**
 * Hub-mode keys. When the search input is focused every printable key
 * edits the query (the chat editor is unfocused on this tab, so we own
 * the keystrokes). Otherwise `j/k` move the cursor, `Enter` installs the
 * selected skill, `/` focuses search, `r` re-browses and `Esc` returns
 * to the list.
 */
function handleHubKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const panel = state.skillsPanel;

  if (panel.hubSearchEditing) {
    if (key.return) {
      dispatch({ type: "skills_hub_search_focus", editing: false });
      callbacks.onSkillHubSearch?.(panel.hubQuery.trim());
      return true;
    }
    if (key.escape) {
      dispatch({ type: "skills_hub_search_focus", editing: false });
      return true;
    }
    if (key.backspace || key.delete) {
      dispatch({
        type: "skills_hub_query_changed",
        query: panel.hubQuery.slice(0, -1),
      });
      return true;
    }
    if (isPrintable(input, key)) {
      dispatch({
        type: "skills_hub_query_changed",
        query: panel.hubQuery + input,
      });
      return true;
    }
    // Swallow every other key while editing so nav hotkeys do not leak.
    return true;
  }

  if (key.escape) {
    dispatch({ type: "skills_hub_closed" });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "skills_hub_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "skills_hub_cursor_moved", delta: -1 });
    return true;
  }
  if (input === "/") {
    dispatch({ type: "skills_hub_search_focus", editing: true });
    return true;
  }
  if (input === "r") {
    callbacks.onSkillHubRefresh?.();
    return true;
  }
  if (key.return) {
    const row = selectedHubRow(ctx);
    if (row) callbacks.onSkillHubCardOpen?.(row);
    return true;
  }
  return false;
}

/**
 * Pre-install card: `i`/`y`/Enter stage + install the skill, `n`/Esc
 * close the card and return to the hub list. Other keys are swallowed so
 * list navigation never leaks through the open card.
 */
function handleHubCardKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const card = state.skillsPanel.hubCard;
  if (!card) return false;
  if (input === "i" || input === "y" || key.return) {
    callbacks.onSkillHubInstall?.(card.identifier, card.source);
    return true;
  }
  if (input === "n" || key.escape) {
    dispatch({ type: "skills_hub_card_closed" });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "skills_hub_card_scrolled", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "skills_hub_card_scrolled", delta: -1 });
    return true;
  }
  if (key.pageDown) {
    dispatch({ type: "skills_hub_card_scrolled", delta: HUB_CARD_BODY_WINDOW });
    return true;
  }
  if (key.pageUp) {
    dispatch({ type: "skills_hub_card_scrolled", delta: -HUB_CARD_BODY_WINDOW });
    return true;
  }
  return true;
}

/**
 * Uninstall-confirm modal: `y`/Enter delete, `n`/Esc cancel. Keys are
 * swallowed while a delete is in flight so a double-press cannot stack
 * two uninstalls.
 */
function handleRemoveConfirmKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const confirm = state.skillsPanel.removeConfirm;
  if (!confirm) return false;
  if (confirm.submitting) return true;
  if (input === "y" || key.return) {
    callbacks.onSkillRemoveConfirmed?.(confirm.name);
    return true;
  }
  if (input === "n" || key.escape) {
    dispatch({ type: "skills_remove_confirm_closed" });
    return true;
  }
  return true;
}

/** Install-confirm modal: `y`/Enter confirm, `n`/Esc cancel. */
function handleConfirmKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state, callbacks } = ctx;
  const confirm = state.skillsPanel.installConfirm;
  if (!confirm) return false;
  if (input === "y" || key.return) {
    callbacks.onSkillInstallConfirmed?.(confirm.identifier);
    return true;
  }
  if (input === "n" || key.escape) {
    callbacks.onSkillInstallCancelled?.(confirm.identifier);
    return true;
  }
  return true;
}

function isPrintable(input: string, key: Key): boolean {
  return (
    input.length === 1 &&
    input >= " " &&
    !key.ctrl &&
    !key.meta &&
    !key.tab &&
    !key.return
  );
}

function selectedHubRow(ctx: SkillsTabKeyContext) {
  const panel = ctx.state.skillsPanel;
  if (panel.hubRows.length === 0) return null;
  const clamped = Math.max(
    0,
    Math.min(panel.hubCursor, panel.hubRows.length - 1),
  );
  return panel.hubRows[clamped] ?? null;
}

function handleDetailKey(
  input: string,
  key: Key,
  ctx: SkillsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const detailName = state.skillsPanel.detailName;
  if (key.escape) {
    dispatch({ type: "skills_detail_closed" });
    return true;
  }
  if (!detailName) return false;
  if (input === "e") {
    callbacks.onSkillToggleRequested?.(detailName);
    return true;
  }
  if (input === "r") {
    callbacks.onSkillsRefreshRequested?.();
    return true;
  }
  return false;
}

function selectedVisibleRow(
  panel: SkillsPanelState,
): SkillSummaryRow | null {
  const visible = selectVisibleSkillRows(panel);
  if (visible.length === 0) return null;
  const clamped = Math.max(0, Math.min(panel.cursor, visible.length - 1));
  return visible[clamped] ?? null;
}
