/**
 * Local UI state for the TUI "MCP" tab. Folded by `mcp-reducer.ts`
 * from `mcp_*` actions emitted by `McpOrchestrator` and the keyboard
 * layer. Read-only surface — operators inspect server status and
 * the discovered catalog; mutation (enable/disable/restart) is
 * deferred (see AGENTS.md §"MCP client" — Out of scope).
 */
import type {
  McpPromptMeta,
  McpResourceMeta,
  McpServerState,
  McpToolMeta,
  McpTrustLevel,
} from "../../mcp/mcp-types.js";

export type McpPanelMode = "list" | "detail";

/** Inner sub-tab inside the server detail view. */
export type McpDetailTab = "tools" | "resources" | "prompts";

export const MCP_DETAIL_TAB_ORDER: readonly McpDetailTab[] = [
  "tools",
  "resources",
  "prompts",
] as const;

/**
 * Compact row rendered in the server list. One per configured
 * server. `state` is sourced from `McpServerStatus` and refreshed
 * every tick by the orchestrator.
 */
export interface McpServerRow {
  name: string;
  description: string;
  state: McpServerState;
  trust: McpTrustLevel;
  transportKind: "stdio" | "streamable_http" | "sse";
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastError: string | null;
}

/**
 * Full detail payload for the currently-selected server. Built from
 * the catalog snapshot at open time; refreshes when the orchestrator
 * emits `mcp_detail_refreshed` (same row key, new payload).
 */
export interface McpServerDetail {
  name: string;
  state: McpServerState;
  description: string;
  trust: McpTrustLevel;
  transport: string;
  lastError: string | null;
  tools: readonly McpToolMeta[];
  resources: readonly McpResourceMeta[];
  prompts: readonly McpPromptMeta[];
}

/**
 * Add-server modal state. Operators paste a single `McpServerConfig`
 * JSON object into the multi-line editor; on submit the orchestrator
 * validates it against `parseMcpServers`, merges into `config.json`,
 * and emits a "restart required" runtime info line. Per variant α —
 * the runtime is NOT mutated in-place; the new server is picked up on
 * the next `atomic-agent` boot.
 */
export interface McpAddModalState {
  json: string;
  error: string | null;
  submitting: boolean;
}

/**
 * Remove-server confirmation modal. Carries the target server name
 * (anchor for the prompt + the actual deletion target — never read
 * from the list cursor at confirm-time, since the cursor can move
 * between opening the modal and pressing `y`).
 */
export interface McpRemoveConfirmState {
  name: string;
  error: string | null;
  submitting: boolean;
}

export interface McpPanelState {
  mode: McpPanelMode;
  rows: readonly McpServerRow[];
  cursor: number;
  /** Inner sub-tab in detail mode. */
  detailTab: McpDetailTab;
  /** Cursor inside the active detail tab (tools / resources / prompts). */
  detailCursor: number;
  detailRowKey: string | null;
  detail: McpServerDetail | null;
  lastRefreshedAt: number | null;
  loading: boolean;
  autoRefresh: boolean;
  lastError: string | null;
  /** Shown when no servers are configured. */
  emptyHint: string | null;
  /** Non-null while the add-server modal is open (any panel mode). */
  addModal: McpAddModalState | null;
  /** Non-null while the remove-server confirm modal is open. */
  removeConfirm: McpRemoveConfirmState | null;
}

export function createInitialMcpPanelState(): McpPanelState {
  return {
    mode: "list",
    rows: [],
    cursor: 0,
    detailTab: "tools",
    detailCursor: 0,
    detailRowKey: null,
    detail: null,
    lastRefreshedAt: null,
    loading: false,
    autoRefresh: true,
    lastError: null,
    emptyHint: null,
    addModal: null,
    removeConfirm: null,
  };
}
