import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/mcp-types.js";
import { installPluginFromDir, removePlugin, setPluginCodeAllowed, setPluginEnabled, setPluginPartEnabled } from "./plugin-install.js";
import { loadPluginMcpServers } from "./plugin-mcp.js";
import { createPluginMcpLiveStop, revokedPluginServers, type PluginMcpLiveManager } from "./plugin-mcp-live.js";
import { resetPluginCache } from "./plugin-runtime.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

/** A manager that only remembers which servers are live and why each was removed. */
function fakeManager(names: string[]): PluginMcpLiveManager & { reasons: Record<string, string | undefined> } {
  const live = new Set(names);
  const reasons: Record<string, string | undefined> = {};
  return {
    reasons,
    listServerNames: () => [...live],
    removeServerLive: async (name, reason) => {
      if (!live.delete(name)) return { removed: false, tools: [] };
      reasons[name] = reason;
      return { removed: true, tools: [`mcp.${name}.t`] };
    },
  };
}

describe("plugin MCP live stop (ATO-1407)", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-plugin-mcp-live-"));
    stateDir = join(base, "state");
    resetPluginCache();
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), {
      mcp: {
        local: { command: "node", args: ["s.js"] },
        remote: { type: "http", url: "https://example.invalid/mcp" },
      },
    }), { acceptCode: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function start() {
    const boot = loadPluginMcpServers(stateDir);
    const manager = fakeManager(boot.servers.map(s => s.name));
    const refresh = vi.fn(async () => {});
    const stop = createPluginMcpLiveStop({ stateDir, manager, started: boot.servers, owners: boot.owners, takenNames: new Set(), refresh, env: {} });
    return { boot, manager, refresh, stop };
  }

  it("stops the plugin's local server the moment its code is stopped, and keeps the rest", async () => {
    const { boot, manager, refresh, stop } = start();
    expect(boot.servers.map(s => s.name).sort()).toEqual(["demo-local", "demo-remote"]);
    setPluginCodeAllowed(stateDir, "demo", false);
    expect(await stop.check()).toEqual(["demo-local"]);
    expect(manager.listServerNames()).toEqual(["demo-remote"]);
    expect(manager.reasons["demo-local"]).toMatch(/plugin demo no longer allows this server/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and rebuilds nothing, while the state still allows every server", async () => {
    const { manager, refresh, stop } = start();
    expect(await stop.check()).toEqual([]);
    expect(manager.listServerNames().sort()).toEqual(["demo-local", "demo-remote"]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops every server of a plugin turned off or removed, and one server turned off", async () => {
    let s = start();
    setPluginPartEnabled(stateDir, "demo", "mcp:remote", false);
    expect(await s.stop.check()).toEqual(["demo-remote"]);

    setPluginPartEnabled(stateDir, "demo", "mcp:remote", true);
    s = start();
    setPluginEnabled(stateDir, "demo", false);
    expect((await s.stop.check()).sort()).toEqual(["demo-local", "demo-remote"]);

    setPluginEnabled(stateDir, "demo", true);
    s = start();
    removePlugin(stateDir, "demo");
    expect((await s.stop.check()).sort()).toEqual(["demo-local", "demo-remote"]);
  });

  it("never starts a server: allowing code again after a stop leaves it stopped", async () => {
    const { manager, stop } = start();
    setPluginCodeAllowed(stateDir, "demo", false);
    await stop.check();
    setPluginCodeAllowed(stateDir, "demo", true);
    expect(await stop.check()).toEqual([]);
    expect(manager.listServerNames()).toEqual(["demo-remote"]);
  });

  it("notices a write from another process through the watched state file", async () => {
    const { manager, stop } = start();
    const unwatch = stop.watch(20);
    try {
      setPluginCodeAllowed(stateDir, "demo", false);
      await vi.waitFor(() => expect(manager.listServerNames()).toEqual(["demo-remote"]), { timeout: 3000, interval: 20 });
    } finally {
      unwatch();
    }
  });

  it("treats a name now pointing at a different program as revoked", () => {
    const a = { name: "demo-local", enabled: true, transport: { kind: "stdio", command: "node", args: ["a.js"] } } as McpServerConfig;
    const b = { ...a, transport: { kind: "stdio", command: "node", args: ["b.js"] } } as McpServerConfig;
    expect(revokedPluginServers([a], new Map([[a.name, a]]))).toEqual([]);
    expect(revokedPluginServers([a], new Map([[b.name, b]]))).toEqual(["demo-local"]);
    expect(revokedPluginServers([a], new Map())).toEqual(["demo-local"]);
  });
});
