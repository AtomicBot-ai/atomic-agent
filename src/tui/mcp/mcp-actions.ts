import type {
  McpDetailTab,
  McpServerDetail,
  McpServerRow,
} from "./mcp-panel-state.js";

/**
 * Actions that mutate `state.mcpPanel`. All names are prefixed with
 * `mcp_` so the root reducer can delegate without collisions with
 * other panels.
 */
export type McpAction =
  | { type: "mcp_refresh_requested" }
  | { type: "mcp_refresh_started" }
  | {
      type: "mcp_rows_loaded";
      rows: readonly McpServerRow[];
      emptyHint: string | null;
      at: number;
    }
  | { type: "mcp_refresh_failed"; error: string }
  | { type: "mcp_cursor_moved"; delta: number }
  | { type: "mcp_cursor_set"; row: number }
  | { type: "mcp_auto_refresh_toggled" }
  | {
      type: "mcp_detail_opened";
      rowKey: string;
      detail: McpServerDetail;
    }
  | {
      type: "mcp_detail_refreshed";
      detail: McpServerDetail;
    }
  | { type: "mcp_detail_closed" }
  | { type: "mcp_detail_tab_cycled"; direction: 1 | -1 }
  | { type: "mcp_detail_tab_set"; tab: McpDetailTab }
  | { type: "mcp_detail_cursor_moved"; delta: number }
  | { type: "mcp_add_modal_opened" }
  | { type: "mcp_add_modal_closed" }
  | { type: "mcp_add_json_changed"; json: string }
  | { type: "mcp_add_submit_requested" }
  | { type: "mcp_add_submitting_started" }
  | { type: "mcp_add_validation_failed"; error: string }
  | { type: "mcp_add_failed"; error: string }
  | { type: "mcp_add_succeeded"; name: string }
  | { type: "mcp_remove_confirm_opened"; name: string }
  | { type: "mcp_remove_confirm_closed" }
  | { type: "mcp_remove_submit_requested"; name: string }
  | { type: "mcp_remove_submitting_started" }
  | { type: "mcp_remove_failed"; error: string }
  | { type: "mcp_remove_succeeded"; name: string };

export function isMcpAction(action: { type: string }): action is McpAction {
  return action.type.startsWith("mcp_");
}
