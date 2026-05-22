import type { TuiState } from "../tui-state.js";
import { isMcpAction, type McpAction } from "./mcp-actions.js";
import {
  MCP_DETAIL_TAB_ORDER,
  type McpDetailTab,
  type McpPanelState,
} from "./mcp-panel-state.js";

export function reduceMcpAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isMcpAction(action)) return null;
  const panel = state.mcpPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, mcpPanel: next };
}

function reducePanel(panel: McpPanelState, action: McpAction): McpPanelState {
  switch (action.type) {
    case "mcp_refresh_requested":
      return panel;
    case "mcp_refresh_started":
      return { ...panel, loading: true, lastError: null };
    case "mcp_rows_loaded": {
      const total = action.rows.length;
      return {
        ...panel,
        rows: action.rows,
        emptyHint: action.emptyHint,
        lastRefreshedAt: action.at,
        loading: false,
        cursor: clampCursor(panel.cursor, total),
      };
    }
    case "mcp_refresh_failed":
      return { ...panel, loading: false, lastError: action.error };
    case "mcp_cursor_moved": {
      const total = panel.rows.length;
      return {
        ...panel,
        cursor: Math.max(0, Math.min(total - 1, panel.cursor + action.delta)),
      };
    }
    case "mcp_cursor_set":
      return { ...panel, cursor: clampCursor(action.row, panel.rows.length) };
    case "mcp_auto_refresh_toggled":
      return { ...panel, autoRefresh: !panel.autoRefresh };
    case "mcp_detail_opened":
      return {
        ...panel,
        mode: "detail",
        detailRowKey: action.rowKey,
        detail: action.detail,
        detailTab: "tools",
        detailCursor: 0,
      };
    case "mcp_detail_refreshed":
      return { ...panel, detail: action.detail };
    case "mcp_detail_closed":
      return {
        ...panel,
        mode: "list",
        detailRowKey: null,
        detail: null,
        detailCursor: 0,
      };
    case "mcp_detail_tab_cycled":
      return {
        ...panel,
        detailTab: cycleDetailTab(panel.detailTab, action.direction),
        detailCursor: 0,
      };
    case "mcp_detail_tab_set":
      return { ...panel, detailTab: action.tab, detailCursor: 0 };
    case "mcp_detail_cursor_moved": {
      const total = detailItemCount(panel);
      return {
        ...panel,
        detailCursor: Math.max(
          0,
          Math.min(total - 1, panel.detailCursor + action.delta),
        ),
      };
    }
    case "mcp_add_modal_opened":
      if (panel.addModal !== null) return panel;
      return {
        ...panel,
        addModal: { json: "", error: null, submitting: false },
      };
    case "mcp_add_modal_closed":
      if (panel.addModal === null) return panel;
      return { ...panel, addModal: null };
    case "mcp_add_json_changed":
      if (panel.addModal === null) return panel;
      return {
        ...panel,
        addModal: {
          ...panel.addModal,
          // Flatten newlines / tabs / CR into spaces so a multi-line
          // paste does not blow up the modal height. JSON parsers
          // treat whitespace between tokens as equivalent, and JSON
          // string literals encode \n / \t as escape sequences (never
          // as raw bytes), so this is a lossless transformation on
          // any valid input. Malformed input is left as-is (still
          // flattened) — the validator will surface the real error.
          // We deliberately do NOT collapse runs of spaces: that
          // would interfere with the operator typing a single literal
          // space inside a string value mid-edit.
          json: flattenWhitespace(action.json),
          error: null,
        },
      };
    case "mcp_add_submit_requested":
      // Acknowledgement-only — the orchestrator runs the actual
      // validate/persist and dispatches one of the terminal actions
      // (`mcp_add_validation_failed`, `mcp_add_failed`, `mcp_add_succeeded`).
      return panel;
    case "mcp_add_submitting_started":
      if (panel.addModal === null) return panel;
      return {
        ...panel,
        addModal: { ...panel.addModal, submitting: true, error: null },
      };
    case "mcp_add_validation_failed":
    case "mcp_add_failed":
      if (panel.addModal === null) return panel;
      return {
        ...panel,
        addModal: {
          ...panel.addModal,
          submitting: false,
          error: action.error,
        },
      };
    case "mcp_add_succeeded":
      // Close modal on success — the operator sees a runtime_info line
      // emitted by the orchestrator confirming the write and asking
      // for a restart.
      return { ...panel, addModal: null };
    case "mcp_remove_confirm_opened":
      // Always overwrite the prior state so re-opening with a different
      // server name (or after a stale error) starts from a clean slate.
      return {
        ...panel,
        removeConfirm: {
          name: action.name,
          error: null,
          submitting: false,
        },
      };
    case "mcp_remove_confirm_closed":
      if (panel.removeConfirm === null) return panel;
      return { ...panel, removeConfirm: null };
    case "mcp_remove_submit_requested":
      // Acknowledgement-only — the orchestrator runs the persist.
      return panel;
    case "mcp_remove_submitting_started":
      if (panel.removeConfirm === null) return panel;
      return {
        ...panel,
        removeConfirm: {
          ...panel.removeConfirm,
          submitting: true,
          error: null,
        },
      };
    case "mcp_remove_failed":
      if (panel.removeConfirm === null) return panel;
      return {
        ...panel,
        removeConfirm: {
          ...panel.removeConfirm,
          submitting: false,
          error: action.error,
        },
      };
    case "mcp_remove_succeeded":
      return { ...panel, removeConfirm: null };
  }
}

/**
 * Replace every newline / carriage-return / tab in the input with a
 * single space. Used to flatten multi-line JSON paste into the
 * add-server modal's MultiLineEditor so the modal does not grow
 * vertically with every pasted line. Lossless on valid JSON — JSON
 * string literals encode `\n` and `\t` as escape sequences (the two
 * characters `\` + `n`), not as raw control bytes, so this never
 * mutates a string value. Whitespace between JSON tokens is
 * equivalent regardless of which kind of whitespace it is.
 */
function flattenWhitespace(input: string): string {
  return input.replace(/[\n\r\t]/g, " ");
}

function clampCursor(cursor: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, cursor));
}

function cycleDetailTab(
  current: McpDetailTab,
  direction: 1 | -1,
): McpDetailTab {
  const idx = MCP_DETAIL_TAB_ORDER.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next =
    (safe + direction + MCP_DETAIL_TAB_ORDER.length) %
    MCP_DETAIL_TAB_ORDER.length;
  return MCP_DETAIL_TAB_ORDER[next] ?? MCP_DETAIL_TAB_ORDER[0]!;
}

function detailItemCount(panel: McpPanelState): number {
  if (!panel.detail) return 0;
  switch (panel.detailTab) {
    case "tools":
      return panel.detail.tools.length;
    case "resources":
      return panel.detail.resources.length;
    case "prompts":
      return panel.detail.prompts.length;
  }
}
