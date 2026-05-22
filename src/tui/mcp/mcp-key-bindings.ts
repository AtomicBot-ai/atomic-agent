import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import type { McpPanelState } from "./mcp-panel-state.js";

export interface McpTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Hotkey handler for the MCP tab. Returns `true` when the key was
 * consumed so the editor / global handlers skip it. Read-only
 * surface: navigation + open detail + manual refresh, no mutation.
 */
export function handleMcpTabKey(
  input: string,
  key: Key,
  ctx: McpTabKeyContext,
): boolean {
  const { state } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "mcp") return false;
  const panel = state.mcpPanel;
  // The add-server modal owns its own MultiLineEditor which captures
  // every key via Ink's `useInput`. Returning `false` here lets the
  // editor consume the keystroke; Esc/Ctrl+Enter routing lives on the
  // modal component (`onEscape` / `onSubmit`). Returning `true` only
  // for the "modal-is-open" guard would swallow text input — hence the
  // short-circuit fall-through.
  if (panel.addModal !== null) return false;
  if (panel.removeConfirm !== null) {
    return handleRemoveConfirmKey(input, key, ctx, panel);
  }
  if (panel.mode === "detail") return handleDetailKey(input, key, ctx, panel);
  return handleListKey(input, key, ctx, panel);
}

function handleListKey(
  input: string,
  key: Key,
  ctx: McpTabKeyContext,
  panel: McpPanelState,
): boolean {
  const { dispatch, callbacks } = ctx;
  if (key.downArrow || input === "j") {
    dispatch({ type: "mcp_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "mcp_cursor_moved", delta: -1 });
    return true;
  }
  if (key.return) {
    const row = panel.rows[panel.cursor];
    if (row) {
      callbacks.onMcpDetailRequested?.(row.name);
    }
    return true;
  }
  if (input === "r") {
    dispatch({ type: "mcp_refresh_requested" });
    return true;
  }
  if (input === "a") {
    dispatch({ type: "mcp_auto_refresh_toggled" });
    return true;
  }
  if (input === "n") {
    dispatch({ type: "mcp_add_modal_opened" });
    return true;
  }
  if (input === "d" || key.delete || key.backspace) {
    const row = panel.rows[panel.cursor];
    if (row) {
      dispatch({ type: "mcp_remove_confirm_opened", name: row.name });
    }
    return true;
  }
  return false;
}

function handleRemoveConfirmKey(
  input: string,
  key: Key,
  ctx: McpTabKeyContext,
  panel: McpPanelState,
): boolean {
  const { dispatch, callbacks } = ctx;
  const confirm = panel.removeConfirm;
  if (!confirm) return false;
  // Ignore key input while the request is in flight so a repeated
  // `y` does not enqueue a second `removeServer` after the first one
  // already started writing to config.json.
  if (confirm.submitting) return true;
  if (key.escape || input === "n" || input === "N") {
    dispatch({ type: "mcp_remove_confirm_closed" });
    return true;
  }
  if (input === "y" || input === "Y" || key.return) {
    dispatch({ type: "mcp_remove_submit_requested", name: confirm.name });
    callbacks.onMcpRemoveServer?.(confirm.name);
    return true;
  }
  return true;
}

function handleDetailKey(
  input: string,
  key: Key,
  ctx: McpTabKeyContext,
  panel: McpPanelState,
): boolean {
  const { dispatch } = ctx;
  if (key.escape) {
    dispatch({ type: "mcp_detail_closed" });
    return true;
  }
  if (input === "d") {
    const name = panel.detail?.name;
    if (name) {
      dispatch({ type: "mcp_remove_confirm_opened", name });
    }
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "mcp_detail_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "mcp_detail_cursor_moved", delta: -1 });
    return true;
  }
  if (input === "[" || key.leftArrow) {
    dispatch({ type: "mcp_detail_tab_cycled", direction: -1 });
    return true;
  }
  if (input === "]" || key.rightArrow) {
    dispatch({ type: "mcp_detail_tab_cycled", direction: 1 });
    return true;
  }
  if (input === "1") {
    dispatch({ type: "mcp_detail_tab_set", tab: "tools" });
    return true;
  }
  if (input === "2") {
    dispatch({ type: "mcp_detail_tab_set", tab: "resources" });
    return true;
  }
  if (input === "3") {
    dispatch({ type: "mcp_detail_tab_set", tab: "prompts" });
    return true;
  }
  if (input === "r") {
    dispatch({ type: "mcp_refresh_requested" });
    return true;
  }
  return false;
}
