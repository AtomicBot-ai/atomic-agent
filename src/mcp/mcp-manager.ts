/**
 * MCP server registry + lifecycle manager.
 *
 * Owns one `McpClient` per configured server. Responsibilities:
 *   - Construct clients at bootstrap from `config.mcp.servers[]`.
 *   - Start each enabled client; record outcomes; emit status
 *     transitions through the optional `onStatus` callback.
 *   - Register the discovered tools into the shared `ToolRegistry`
 *     (under their qualified names) and install the dynamic
 *     resource-class resolver so MCP names route to the right
 *     batching lane.
 *   - Stop and tear everything down on `shutdown()`.
 *
 * The manager is **always** constructed (mirrors the Telegram
 * channel pattern) — even when `config.mcp.servers[]` is empty —
 * so the bootstrap wiring stays uniform. An empty config produces a
 * zero-cost no-op manager.
 *
 * No periodic timers, no background polling. Servers that need a
 * fresh catalog after a `notifications/tools/list_changed`
 * notification are handled by the SDK's `listChanged` config
 * (currently disabled — first phase ships catalog snapshots only).
 */

import { setDynamicResourceClassResolver } from "../agent/tool-resource-class.js";
import type { DangerousToolOptions } from "../approval/dangerous-tool.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

import { McpClient, type McpClientDeps } from "./mcp-client.js";
import { McpConnectError, scrubErrorMessage } from "./mcp-errors.js";
import { createMcpResourceClassResolver } from "./mcp-resource-class.js";
import { createMcpToolDefinition } from "./mcp-tool-adapter.js";
import type {
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
  McpToolMeta,
  McpTrustLevel,
} from "./mcp-types.js";

/**
 * Status sink. Mirrors `runtime.onChannelStatus` so the host can
 * surface MCP lifecycle transitions in the same way it handles the
 * Telegram channel.
 */
export type McpStatusSink = (status: McpServerStatus) => void;

export interface McpManagerDeps extends McpClientDeps {
  /** Shared registry — tools are added to / removed from in place. */
  toolRegistry: ToolRegistry;
  /** Optional status sink. Failures inside the sink are swallowed. */
  onStatus?: McpStatusSink;
  /** Structured logger for lifecycle events. */
  logger?: StructuredLogger;
  /**
   * Approval-gate wiring — the same shared object the native
   * dangerous tools (`os.shell.run`, `os.fs.write`, …) receive.
   * Tools from a server whose resolved trust is `approval_gated`
   * call `requireApproval` before every `tools/call` (discovery-time
   * `annotations.readOnlyHint === true` exempts). Optional only as a
   * test seam — production bootstrap always passes it.
   */
  dangerous?: DangerousToolOptions;
}

/**
 * Per-server bookkeeping. Tracks the current connect state and the
 * tools registered into `ToolRegistry` so we can unregister cleanly
 * on stop / reload.
 */
interface ManagedServer {
  config: McpServerConfig;
  client: McpClient;
  registeredToolNames: string[];
  state: McpServerStatus["state"];
  lastError?: string;
}

export class McpManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly deps: McpManagerDeps;
  private resolverInstalled = false;

  constructor(configs: readonly McpServerConfig[], deps: McpManagerDeps) {
    this.deps = deps;
    for (const cfg of configs) {
      this.addServer(cfg);
    }
  }

  /** List of configured server names (preserves insertion order). */
  listServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /** Snapshot of every server's current status. */
  listStatuses(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const s of this.servers.values()) {
      const catalog = s.client.getCatalog();
      out.push({
        name: s.config.name,
        state: s.state,
        ts: Date.now(),
        ...(s.lastError ? { lastError: s.lastError } : {}),
        toolCount: catalog.tools.length,
        resourceCount: catalog.resources.length,
        promptCount: catalog.prompts.length,
      });
    }
    return out;
  }

  /** Look up a client by server name. Returns `undefined` when absent. */
  getClient(server: string): McpClient | undefined {
    return this.servers.get(server)?.client;
  }

  /** Look up a catalog snapshot by server name. */
  getCatalog(server: string): McpServerCatalog | undefined {
    return this.servers.get(server)?.client.getCatalog();
  }

  /** Aggregate snapshot — every connected server's catalog. */
  listCatalogs(): McpServerCatalog[] {
    const out: McpServerCatalog[] = [];
    for (const s of this.servers.values()) {
      if (s.state === "up") out.push(s.client.getCatalog());
    }
    return out;
  }

  /** Aggregate list of every connected server's `McpToolMeta`. */
  listAllToolMeta(): McpToolMeta[] {
    const out: McpToolMeta[] = [];
    for (const s of this.servers.values()) {
      if (s.state === "up") {
        out.push(...s.client.getCatalog().tools);
      }
    }
    return out;
  }

  /**
   * Connect every enabled server. Failures are isolated per-server
   * — one bad config does not abort the rest. Always installs the
   * dynamic resource-class resolver (even when no server connects)
   * so a stale model-emitted MCP name falls into `approval_gated`
   * instead of `unknown`.
   */
  async start(): Promise<void> {
    this.ensureResolver();
    await Promise.all(
      Array.from(this.servers.values()).map((s) => this.startOne(s)),
    );
  }

  /**
   * Stop every connected client. Best-effort — individual close
   * errors are swallowed. Always tears down every registered tool
   * and clears the dynamic resolver.
   */
  async shutdown(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const s of this.servers.values()) {
      this.unregisterToolsFor(s);
      s.state = "down";
      closes.push(s.client.close().catch(() => {}));
    }
    await Promise.all(closes);
    if (this.resolverInstalled) {
      setDynamicResourceClassResolver(null);
      this.resolverInstalled = false;
    }
  }

  /**
   * Live-add a server from a config previously written into
   * `<stateDir>/config.json` (variant γ in AGENTS.md §"MCP client").
   * The bootstrap-time path uses the constructor; this path is the
   * TUI-driven equivalent that comes after `persistMcpServer`. Idempotent
   * on the server name — a second call with the same name short-circuits
   * to `{ added: false }` and does NOT re-trigger a connect.
   *
   * Returns the freshly-discovered tool metas (empty when the server
   * connected disabled or failed mid-handshake). The caller is
   * expected to plumb this through `runtime.refreshMcp()` so the
   * stable-prefix tools catalog and GBNF grammar pick up the new
   * names on the next inference. KV-cache invalidation is intentional
   * — semantically equivalent to a restart.
   */
  async addServerLive(config: McpServerConfig): Promise<{
    added: boolean;
    tools: McpToolMeta[];
  }> {
    if (this.servers.has(config.name)) {
      this.deps.logger?.warn("mcp.live_add_already_present", {
        server: config.name,
      });
      return { added: false, tools: [] };
    }
    this.addServer(config);
    const s = this.servers.get(config.name);
    if (!s) return { added: false, tools: [] };
    await this.startOne(s);
    return { added: true, tools: [...s.client.getCatalog().tools] };
  }

  /**
   * Live-remove a server (variant γ). Disconnects, unregisters its
   * tools from `ToolRegistry`, and drops the entry from the manager's
   * Map. After this call, `runtime.refreshMcp()` should be invoked so
   * the stable-prefix catalog and grammar drop the qualified names
   * too. Idempotent on absence — removing a non-existent name
   * short-circuits to `{ removed: false }`.
   */
  async removeServerLive(name: string): Promise<{
    removed: boolean;
    tools: string[];
  }> {
    const s = this.servers.get(name);
    if (!s) {
      this.deps.logger?.warn("mcp.live_remove_missing", { server: name });
      return { removed: false, tools: [] };
    }
    const tools = [...s.registeredToolNames];
    await this.stopOne(s);
    this.servers.delete(name);
    // Rebuild the resource-class resolver so the now-gone server name
    // no longer satisfies the lookup; future model emissions of its
    // qualified names fall back to "unknown" and the validator
    // rejects them at the batch boundary.
    this.ensureResolver();
    this.deps.logger?.info("mcp.live_remove_ok", {
      server: name,
      tools: tools.length,
    });
    return { removed: true, tools };
  }

  /** Stop + start a single server. Useful for the TUI restart command. */
  async restartServer(server: string): Promise<void> {
    const s = this.servers.get(server);
    if (!s) return;
    await this.stopOne(s);
    if (s.config.enabled) {
      await this.startOne(s);
    }
  }

  /**
   * Flip a server's `enabled` flag at runtime. The config object
   * itself is owned by the runtime; this manager only mutates its
   * own copy and reconciles the connection state.
   */
  async setServerEnabled(server: string, enabled: boolean): Promise<void> {
    const s = this.servers.get(server);
    if (!s) return;
    s.config = { ...s.config, enabled };
    if (enabled) {
      if (s.state !== "up") await this.startOne(s);
    } else {
      await this.stopOne(s);
    }
  }

  private addServer(config: McpServerConfig): void {
    if (this.servers.has(config.name)) {
      this.deps.logger?.warn("mcp.duplicate_server_dropped", {
        server: config.name,
      });
      return;
    }
    const client = new McpClient(config, this.deps);
    this.servers.set(config.name, {
      config,
      client,
      registeredToolNames: [],
      state: config.enabled ? "starting" : "disabled",
    });
  }

  private async startOne(s: ManagedServer): Promise<void> {
    if (!s.config.enabled) {
      this.transition(s, "disabled");
      return;
    }
    this.transition(s, "starting");
    try {
      await s.client.connect();
      this.registerToolsFor(s);
      this.transition(s, "up");
      this.deps.logger?.info("mcp.server_up", {
        server: s.config.name,
        tools: s.registeredToolNames.length,
      });
    } catch (err) {
      const msg = err instanceof McpConnectError ? err.message : scrubErrorMessage(err);
      s.lastError = msg;
      this.transition(s, "down");
      this.deps.logger?.warn("mcp.server_down", {
        server: s.config.name,
        reason: msg,
      });
    }
  }

  private async stopOne(s: ManagedServer): Promise<void> {
    this.unregisterToolsFor(s);
    try {
      await s.client.close();
    } catch {
      // best-effort
    }
    s.lastError = undefined;
    this.transition(s, s.config.enabled ? "down" : "disabled");
  }

  private registerToolsFor(s: ManagedServer): void {
    const catalog = s.client.getCatalog();
    // Same resolution as `ensureResolver` — missing trust fails closed
    // to `approval_gated`, so an unannotated server is gated by default.
    const trust = s.config.trust ?? "approval_gated";
    for (const meta of catalog.tools) {
      const def = createMcpToolDefinition(meta, s.client, {
        trust,
        dangerous: this.deps.dangerous,
      });
      // ToolRegistry.register is last-writer-wins. Two servers
      // cannot collide because the qualified name carries the
      // server name; two distinct servers with the same raw tool
      // name yield distinct qualified names.
      this.deps.toolRegistry.register(def);
      s.registeredToolNames.push(def.name);
    }
    this.ensureResolver();
  }

  private unregisterToolsFor(s: ManagedServer): void {
    if (s.registeredToolNames.length === 0) return;
    for (const name of s.registeredToolNames) {
      this.deps.toolRegistry.unregister(name);
    }
    s.registeredToolNames = [];
  }

  /**
   * Re-install the dynamic resolver. Idempotent — the underlying
   * setter holds at most one resolver at a time, and rebuilding the
   * map is cheap (Map size = server count).
   */
  private ensureResolver(): void {
    const trustMap = new Map<string, McpTrustLevel>();
    for (const s of this.servers.values()) {
      trustMap.set(s.config.name, s.config.trust ?? "approval_gated");
    }
    setDynamicResourceClassResolver(createMcpResourceClassResolver(trustMap));
    this.resolverInstalled = true;
  }

  private transition(s: ManagedServer, next: McpServerStatus["state"]): void {
    if (s.state === next) return;
    s.state = next;
    const catalog = s.client.getCatalog();
    const status: McpServerStatus = {
      name: s.config.name,
      state: next,
      ts: Date.now(),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      toolCount: catalog.tools.length,
      resourceCount: catalog.resources.length,
      promptCount: catalog.prompts.length,
    };
    if (this.deps.onStatus) {
      try {
        this.deps.onStatus(status);
      } catch {
        // sink errors must never derail lifecycle
      }
    }
  }
}

/** Re-export so qualified-name helpers are reachable from one place. */
export { splitMcpToolName, qualifyMcpToolName } from "./mcp-resource-class.js";
