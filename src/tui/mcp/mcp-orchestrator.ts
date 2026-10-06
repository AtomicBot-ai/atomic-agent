/**
 * Orchestrator for the TUI "MCP" tab.
 *
 * This is the **only** TUI module that touches `runtime.mcpManager`
 * (mirrors the `Memory` / `Tasks` / `Telegram` orchestrators).
 * Components dispatch actions; the orchestrator owns the polling
 * loop, snapshots the manager state, and emits typed actions onto
 * the shared bus.
 */

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { getConfig } from "../../config/index.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import type { TuiEventBusEmitter } from "../make-event-bus.js";
import {
  McpAddServerError,
  McpRemoveServerError,
  parseAddServerJson,
  persistMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
} from "../../config/mcp-server-commands.js";
import { isMcpAction } from "./mcp-actions.js";
import type { McpServerDetail, McpServerRow } from "./mcp-panel-state.js";

/** Only the runtime operations owned by the MCP panel; full AgentRuntime is compatible. */
export interface McpOrchestratorRuntime {
  readonly mcpManager: Pick<
    AgentRuntime["mcpManager"],
    | "listStatuses"
    | "getCatalog"
    | "addServerLive"
    | "removeServerLive"
    | "restartServer"
    | "setServerEnabled"
  >;
  refreshMcp: AgentRuntime["refreshMcp"];
}

export interface McpOrchestratorOptions {
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;

export class McpOrchestrator {
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;
  /** `rowKey` (server name) of the currently-open detail view, if any. */
  private openDetailKey: string | null = null;
  /** Server names with a restart / enable toggle in flight. */
  private readonly busyServers = new Set<string>();

  constructor(
    private readonly runtime: McpOrchestratorRuntime,
    private readonly bus: Pick<TuiEventBusEmitter, "subscribe" | "emit">,
    options: McpOrchestratorOptions = {},
  ) {
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.bus.subscribe((action) => {
      if (!isMcpAction(action)) return;
      switch (action.type) {
        case "mcp_refresh_requested":
          this.refresh();
          break;
        case "mcp_detail_closed":
          this.openDetailKey = null;
          break;
        default:
          break;
      }
    });
  }

  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refresh();
    this.refreshTimer = setInterval(
      () => this.refresh(),
      this.refreshIntervalMs,
    );
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Public snapshot path — also runs on every interval tick. */
  refresh(): void {
    try {
      this.bus.emit({ type: "mcp_refresh_started" });
      const rows = buildRows(this.runtime);
      const emptyHint =
        rows.length === 0
          ? "no MCP servers configured — add entries under `mcp.servers[]` in config.json"
          : null;
      this.bus.emit({
        type: "mcp_rows_loaded",
        rows,
        emptyHint,
        at: Date.now(),
      });
      if (this.openDetailKey !== null) {
        const detail = buildDetail(this.runtime, this.openDetailKey);
        if (detail) {
          this.bus.emit({ type: "mcp_detail_refreshed", detail });
        } else {
          this.openDetailKey = null;
          this.bus.emit({ type: "mcp_detail_closed" });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "mcp_refresh_failed", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `mcp refresh failed: ${msg}`,
      });
    }
  }

  /**
   * Append a new MCP server to `<stateDir>/config.json` from a
   * JSON-paste payload, then connect it live via
   * `McpManager.addServerLive` + `runtime.refreshMcp()`.
   *
   * Validation errors (malformed JSON, schema rejection, duplicate
   * name) are folded into `mcp_add_validation_failed`; write errors
   * into `mcp_add_failed`. On success, `mcp_add_succeeded` fires and
   * the modal closes; the panel refreshes so the new row shows up
   * with its live state.
   */
  addServerFromJson(json: string): void {
    void this.addServerFromJsonAsync(json);
  }

  private async addServerFromJsonAsync(json: string): Promise<void> {
    this.bus.emit({ type: "mcp_add_submitting_started" });
    let parsed;
    try {
      parsed = parseAddServerJson(json);
    } catch (err) {
      const msg =
        err instanceof McpAddServerError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.bus.emit({ type: "mcp_add_validation_failed", error: msg });
      return;
    }
    // Persist first — the write is synchronous and the only operation
    // that can reject. Live connection failures fall back to the same
    // "server is `down`" UX as a configured-but-unreachable server,
    // not a hard failure of the add flow.
    let persisted;
    try {
      persisted = persistMcpServer(parsed);
    } catch (err) {
      const msg =
        err instanceof McpAddServerError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.bus.emit({ type: "mcp_add_failed", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `mcp: add failed — ${msg}`,
      });
      return;
    }
    this.bus.emit({ type: "mcp_add_succeeded", name: persisted.server.name });
    try {
      const { added, tools } = await this.runtime.mcpManager.addServerLive(
        persisted.server,
      );
      if (added) {
        await this.runtime.refreshMcp();
        this.bus.emit({
          type: "runtime_info",
          line: `mcp: added ${JSON.stringify(persisted.server.name)} (${tools.length} tools, ${persisted.totalServers} total)`,
        });
      } else {
        // The manager skipped because a server with the same name was
        // already alive. Treat the user-visible flow as a success
        // anyway — config.json was updated, and `refresh()` below
        // picks up the new entry.
        this.bus.emit({
          type: "runtime_info",
          line: `mcp: ${JSON.stringify(persisted.server.name)} already live — config.json updated, ${persisted.totalServers} total`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "runtime_info",
        line: `mcp: live connect failed for ${JSON.stringify(persisted.server.name)} — ${msg} (still in config, will retry on restart)`,
      });
    }
    this.refresh();
  }

  /**
   * Remove an MCP server from `<stateDir>/config.json` by name, then
   * disconnect it live via `McpManager.removeServerLive` +
   * `runtime.refreshMcp()`.
   *
   * Failures (missing entry, validation error on the rewritten file)
   * fold into `mcp_remove_failed` and the modal stays open so the
   * operator sees the reason inline. On success the detail view is
   * closed when the removed name matches the open server.
   */
  removeServer(name: string): void {
    void this.removeServerAsync(name);
  }

  private async removeServerAsync(name: string): Promise<void> {
    this.bus.emit({ type: "mcp_remove_submitting_started" });
    let result;
    try {
      result = removeMcpServer(name);
    } catch (err) {
      const msg =
        err instanceof McpRemoveServerError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.bus.emit({ type: "mcp_remove_failed", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `mcp: remove failed — ${msg}`,
      });
      return;
    }
    this.bus.emit({ type: "mcp_remove_succeeded", name: result.removed });
    if (this.openDetailKey === result.removed) {
      this.openDetailKey = null;
      this.bus.emit({ type: "mcp_detail_closed" });
    }
    try {
      const live = await this.runtime.mcpManager.removeServerLive(
        result.removed,
      );
      await this.runtime.refreshMcp();
      this.bus.emit({
        type: "runtime_info",
        line: live.removed
          ? `mcp: removed ${JSON.stringify(result.removed)} (${live.tools.length} tools dropped, ${result.totalServers} remaining)`
          : `mcp: ${JSON.stringify(result.removed)} was already absent live — config.json updated, ${result.totalServers} remaining`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "runtime_info",
        line: `mcp: live disconnect failed for ${JSON.stringify(result.removed)} — ${msg} (config.json already updated)`,
      });
    }
    this.refresh();
  }

  /**
   * Stop + start one server live (`R` on the MCP tab). A server that is
   * in config but unknown to the manager (e.g. added through
   * `PATCH /api/config`) is connected via `addServerLive` instead.
   * Config is not touched.
   */
  restartServer(name: string): void {
    void this.runServerOp(name, async (cfg) => {
      const mgr = this.runtime.mcpManager;
      if (!(await mgr.restartServer(name))) await mgr.addServerLive(cfg);
      return `restarted ${JSON.stringify(name)}`;
    });
  }

  /**
   * Flip one server's `enabled` flag (`e` on the MCP tab): persist it to
   * `<stateDir>/config.json` the same way add/remove do, then connect
   * or disconnect it live.
   */
  toggleServerEnabled(name: string): void {
    void this.runServerOp(name, async (cfg) => {
      const { server } = setMcpServerEnabled(name, !cfg.enabled);
      const mgr = this.runtime.mcpManager;
      if (!(await mgr.setServerEnabled(name, server.enabled))) {
        await mgr.addServerLive(server);
      }
      return `${server.enabled ? "enabled" : "disabled"} ${JSON.stringify(name)}`;
    });
  }

  private async runServerOp(
    name: string,
    op: (cfg: McpServerConfig) => Promise<string>,
  ): Promise<void> {
    if (this.busyServers.has(name)) return;
    const cfg = readConfiguredServers().find((s) => s.name === name);
    if (!cfg) {
      this.bus.emit({
        type: "runtime_info",
        line: `mcp: ${JSON.stringify(name)} not found in config.json`,
      });
      return;
    }
    this.busyServers.add(name);
    try {
      const done = await op(cfg);
      await this.runtime.refreshMcp();
      this.bus.emit({ type: "runtime_info", line: `mcp: ${done}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "runtime_info",
        line: `mcp: ${JSON.stringify(name)} failed — ${msg}`,
      });
    } finally {
      this.busyServers.delete(name);
    }
    this.refresh();
  }

  /**
   * Open the detail view for the server at the given row key (server
   * name). Emits `mcp_detail_opened` with a freshly-built payload.
   */
  openDetail(serverName: string): void {
    try {
      const detail = buildDetail(this.runtime, serverName);
      if (!detail) {
        this.bus.emit({
          type: "runtime_info",
          line: `mcp detail unavailable for ${serverName}`,
        });
        return;
      }
      this.openDetailKey = serverName;
      this.bus.emit({
        type: "mcp_detail_opened",
        rowKey: serverName,
        detail,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "mcp_refresh_failed", error: msg });
    }
  }
}

/**
 * Read the **current** MCP server list from the live config cache —
 * NOT from `runtime.config`, which is a frozen snapshot captured at
 * bootstrap. `persistMcpServer` / `removeMcpServer` call
 * `resetConfigCache()` after writing, so `getConfig()` returns the
 * fresh list on the next call. This is what makes the TUI refresh
 * reflect adds/removes without a runtime restart.
 *
 * Live `McpManager` state (statuses, catalogs) is read from the
 * runtime directly — the manager is mutated in place by live add /
 * remove / restart / enable toggles, not snapshotted. A server that is
 * in config but unknown to the manager (edited in through
 * `PATCH /api/config`) shows as `down` / `disabled` until a restart
 * (`R`) connects it.
 */
function readConfiguredServers(): readonly McpServerConfig[] {
  return getConfig().mcp?.servers ?? [];
}

function buildRows(runtime: McpOrchestratorRuntime): McpServerRow[] {
  const configs = readConfiguredServers();
  if (configs.length === 0) return [];
  const statuses = new Map(
    runtime.mcpManager.listStatuses().map((s) => [s.name, s]),
  );
  const rows: McpServerRow[] = [];
  for (const cfg of configs) {
    const status = statuses.get(cfg.name);
    rows.push({
      name: cfg.name,
      description: cfg.description ?? "",
      state: status?.state ?? (cfg.enabled ? "down" : "disabled"),
      trust: cfg.trust ?? "approval_gated",
      transportKind: cfg.transport.kind,
      toolCount: status?.toolCount ?? 0,
      resourceCount: status?.resourceCount ?? 0,
      promptCount: status?.promptCount ?? 0,
      lastError: status?.lastError ?? null,
    });
  }
  return rows;
}

function buildDetail(
  runtime: McpOrchestratorRuntime,
  serverName: string,
): McpServerDetail | null {
  const cfg = readConfiguredServers().find((s) => s.name === serverName);
  if (!cfg) return null;
  const status = runtime.mcpManager
    .listStatuses()
    .find((s) => s.name === serverName);
  const catalog = runtime.mcpManager.getCatalog(serverName);
  return {
    name: cfg.name,
    description: cfg.description ?? "",
    state: status?.state ?? (cfg.enabled ? "down" : "disabled"),
    trust: cfg.trust ?? "approval_gated",
    transport: describeTransport(cfg),
    lastError: status?.lastError ?? null,
    tools: catalog?.tools ?? [],
    resources: catalog?.resources ?? [],
    prompts: catalog?.prompts ?? [],
  };
}

function describeTransport(cfg: McpServerConfig): string {
  switch (cfg.transport.kind) {
    case "stdio": {
      const argsPart =
        cfg.transport.args && cfg.transport.args.length > 0
          ? ` ${cfg.transport.args.join(" ")}`
          : "";
      const cwdPart = cfg.transport.cwd ? ` (cwd: ${cfg.transport.cwd})` : "";
      return `stdio: ${cfg.transport.command}${argsPart}${cwdPart}`;
    }
    case "streamable_http":
      return `streamable_http: ${cfg.transport.url}`;
    case "sse":
      return `sse: ${cfg.transport.url}`;
  }
}
