import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { selectVisibleSkillRows } from "./skills-filter.js";
import type {
  SkillSummaryRow,
  SkillsPanelState,
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
  return false;
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
