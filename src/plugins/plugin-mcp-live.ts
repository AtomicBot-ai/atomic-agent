import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/mcp-types.js";
import { loadPluginMcpServers } from "./plugin-mcp.js";
import { resetPluginCache } from "./plugin-runtime.js";
import { pluginsRoot } from "./plugin-store.js";

/** The two manager calls the live stop needs (`McpManager` satisfies it). */
export interface PluginMcpLiveManager {
  listServerNames(): string[];
  removeServerLive(name: string, reason?: string): Promise<{ removed: boolean; tools: string[] }>;
}

export interface PluginMcpLiveDeps {
  stateDir: string;
  manager: PluginMcpLiveManager;
  /** Plugin servers the manager was started with. */
  started: readonly McpServerConfig[];
  /** Server name → plugin, from the same `loadPluginMcpServers` call. */
  owners: Readonly<Record<string, string>>;
  /** The user's own server names, reserved exactly as at start. */
  takenNames: ReadonlySet<string>;
  /** Rebuild the prompt's tool catalog and grammar (`runtime.refreshMcp`). */
  refresh: () => Promise<void>;
  env?: Readonly<Record<string, string | undefined>>;
  logger?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
}

export interface PluginMcpLiveStop {
  /** Re-read plugin state and stop every started server it no longer allows. Returns the names stopped. */
  check(): Promise<string[]>;
  /** Watch `plugins.json` and run `check` on every change. Returns the unwatch. */
  watch(intervalMs?: number): () => void;
}

/**
 * Plugin MCP servers start once, with the agent. When the user stops a
 * plugin's code (`plugin deny-code`, desktop "Stop its code", TUI
 * `/plugins`), turns the plugin or one of its servers off, or removes
 * it, the running servers it no longer allows are stopped at once: their
 * process ends, their tools leave the catalog, and a call still waiting
 * on one ends with an error naming the reason. The write may come from
 * another process (the CLI the desktop runs), so the state file is
 * watched rather than called into.
 *
 * Only stops, never starts: allowing code or turning a server on still
 * waits for the next agent start, with the consent it asked for then.
 */
export function createPluginMcpLiveStop(deps: PluginMcpLiveDeps): PluginMcpLiveStop {
  const live = new Map(deps.started.map(s => [s.name, s]));
  let running: Promise<string[]> | null = null;
  let again = false;

  const runOnce = async (): Promise<string[]> => {
    if (live.size === 0) return [];
    let allowed: Map<string, McpServerConfig>;
    try {
      resetPluginCache();
      const { servers } = loadPluginMcpServers(deps.stateDir, deps.takenNames, deps.env ?? process.env);
      allowed = new Map(servers.map(s => [s.name, s]));
    } catch (err) {
      deps.logger?.warn("plugin MCP state unreadable; servers left as they are", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
    const stale = revokedPluginServers([...live.values()], allowed);
    if (stale.length === 0) return [];
    const present = new Set(deps.manager.listServerNames());
    const stopped: string[] = [];
    for (const name of stale) {
      live.delete(name);
      if (!present.has(name)) continue;
      const plugin = deps.owners[name] ?? name;
      const { removed } = await deps.manager.removeServerLive(name, `plugin ${plugin} no longer allows this server (its code was stopped, or it was turned off or removed)`);
      if (removed) stopped.push(name);
    }
    if (stopped.length > 0) {
      deps.logger?.info("plugin MCP servers stopped", { servers: stopped });
      await deps.refresh();
    }
    return stopped;
  };

  const check = async (): Promise<string[]> => {
    if (running) { again = true; return running; }
    running = (async () => {
      const out: string[] = [];
      do {
        again = false;
        out.push(...await runOnce());
      } while (again);
      return out;
    })();
    try { return await running; } finally { running = null; }
  };

  const watch = (intervalMs = 1000): (() => void) => {
    const file = join(pluginsRoot(deps.stateDir), "plugins.json");
    const listener = (): void => {
      check().catch(err => deps.logger?.warn("plugin MCP live stop failed", { error: err instanceof Error ? err.message : String(err) }));
    };
    // Polled stat, not fs.watch: the store replaces the file by rename,
    // and the poll needs nothing kept open. Not persistent: never holds the process.
    watchFile(file, { interval: intervalMs, persistent: false }, listener);
    return () => unwatchFile(file, listener);
  };

  return { check, watch };
}

/**
 * Started servers that are gone from the current allowed set, or whose
 * transport changed under the same name (names are `<plugin>-<server>`,
 * suffixed on collision, so a name alone could point at another server).
 */
export function revokedPluginServers(started: readonly McpServerConfig[], allowed: ReadonlyMap<string, McpServerConfig>): string[] {
  return started
    .filter(s => {
      const now = allowed.get(s.name);
      return !now || JSON.stringify(now.transport) !== JSON.stringify(s.transport);
    })
    .map(s => s.name);
}
