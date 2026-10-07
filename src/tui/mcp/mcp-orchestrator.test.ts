import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/config-cache.js";
import { parseAddServerJson, persistMcpServer } from "../../config/mcp-server-commands.js";
import { makeTuiEventBus } from "../make-event-bus.js";
import type { TuiAction } from "../tui-action.js";
import {
  McpOrchestrator,
  type McpOrchestratorRuntime,
} from "./mcp-orchestrator.js";

type Manager = McpOrchestratorRuntime["mcpManager"];

function server(name = "docs") {
  return parseAddServerJson(JSON.stringify({ name, command: "unused-test-process" }));
}

function fixture() {
  const manager = {
    listStatuses: vi.fn<Manager["listStatuses"]>(() => []),
    getCatalog: vi.fn<Manager["getCatalog"]>(() => undefined),
    addServerLive: vi.fn<Manager["addServerLive"]>(async () => ({ added: true, tools: [] })),
    removeServerLive: vi.fn<Manager["removeServerLive"]>(async () => ({ removed: true, tools: [] })),
    restartServer: vi.fn<Manager["restartServer"]>(async () => true),
    setServerEnabled: vi.fn<Manager["setServerEnabled"]>(async () => true),
  } satisfies Manager;
  const refreshMcp = vi.fn<McpOrchestratorRuntime["refreshMcp"]>(async () => {});
  const runtime = { mcpManager: manager, refreshMcp } satisfies McpOrchestratorRuntime;
  const actions: TuiAction[] = [];
  const bus = makeTuiEventBus();
  bus.subscribe((action) => actions.push(action));
  const orchestrator = new McpOrchestrator(runtime, bus, { refreshIntervalMs: 100 });
  return { orchestrator, manager, refreshMcp, actions, bus };
}

async function settle(actions: TuiAction[], snapshots = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(actions.filter((action) => action.type === "mcp_rows_loaded")).toHaveLength(snapshots);
  }, { interval: 10 });
}

function info(actions: TuiAction[]): string[] {
  return actions.flatMap((action) => action.type === "runtime_info" ? [action.line] : []);
}

describe("MCP orchestrator persistence and lifecycle", () => {
  let stateDir: string;
  const orchestrators: McpOrchestrator[] = [];
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mcp-orchestrator-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
  });
  afterEach(() => {
    for (const orchestrator of orchestrators.splice(0)) orchestrator.shutdown();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });
  function mount() {
    const view = fixture();
    orchestrators.push(view.orchestrator);
    return view;
  }

  it("persists before live add, then refreshes the runtime catalog", async () => {
    const f = mount();
    f.manager.addServerLive.mockImplementation(async (entry) => {
      expect(getConfig().mcp.servers).toEqual([entry]);
      expect(f.actions).toContainEqual({ type: "mcp_add_succeeded", name: "docs" });
      return { added: true, tools: [] };
    });
    f.orchestrator.addServerFromJson(JSON.stringify(server()));
    await settle(f.actions);
    expect(f.manager.addServerLive).toHaveBeenCalledOnce();
    expect(f.refreshMcp).toHaveBeenCalledOnce();
    expect(info(f.actions)).toContain('mcp: added "docs" (0 tools, 1 total)');
    expect(f.actions).toContainEqual(expect.objectContaining({ type: "mcp_rows_loaded", rows: [expect.objectContaining({ name: "docs", state: "down" })] }));
  });

  it("keeps the written server and reports live-connect failure without claiming a rollback", async () => {
    const f = mount();
    f.manager.addServerLive.mockRejectedValue(new Error("offline fixture"));
    f.orchestrator.addServerFromJson(JSON.stringify(server()));
    await settle(f.actions);
    expect(getConfig().mcp.servers.map((entry) => entry.name)).toEqual(["docs"]);
    expect(f.refreshMcp).not.toHaveBeenCalled();
    expect(info(f.actions)).toEqual(['mcp: live connect failed for "docs" — offline fixture (still in config, will retry on restart)']);
    expect(f.actions.some((action) => action.type === "mcp_add_failed")).toBe(false);
  });

  it("rejects duplicate configuration before dispatching a second live add", () => {
    persistMcpServer(server());
    const f = mount();
    f.orchestrator.addServerFromJson(JSON.stringify(server()));
    expect(f.manager.addServerLive).not.toHaveBeenCalled();
    expect(f.actions).toContainEqual(expect.objectContaining({ type: "mcp_add_failed", error: expect.stringContaining("already exists") }));
    expect(getConfig().mcp.servers).toHaveLength(1);
  });

  it("removes configuration and closes its detail even if live disconnect fails", async () => {
    persistMcpServer(server());
    const f = mount();
    f.orchestrator.openDetail("docs");
    f.manager.removeServerLive.mockImplementation(async (name) => {
      expect(name).toBe("docs");
      expect(getConfig().mcp.servers).toEqual([]);
      throw new Error("disconnect fixture");
    });
    f.orchestrator.removeServer("docs");
    await settle(f.actions);
    expect(f.actions).toContainEqual({ type: "mcp_detail_closed" });
    expect(f.actions).toContainEqual({ type: "mcp_remove_succeeded", name: "docs" });
    expect(info(f.actions)).toContain('mcp: live disconnect failed for "docs" — disconnect fixture (config.json already updated)');
  });

  it("serializes toggle/restart for one server and releases the busy guard after failure", async () => {
    persistMcpServer(server());
    const f = mount();
    let reject!: (reason: Error) => void;
    const pending = new Promise<boolean>((_resolve, onReject) => { reject = onReject; });
    f.manager.setServerEnabled.mockImplementation((name, enabled) => {
      expect(name).toBe("docs");
      expect(enabled).toBe(false);
      expect(getConfig().mcp.servers[0]?.enabled).toBe(false);
      return pending;
    });
    f.orchestrator.toggleServerEnabled("docs");
    f.orchestrator.toggleServerEnabled("docs");
    f.orchestrator.restartServer("docs");
    expect(f.manager.setServerEnabled).toHaveBeenCalledOnce();
    expect(f.manager.restartServer).not.toHaveBeenCalled();
    reject(new Error("toggle fixture"));
    await settle(f.actions);
    expect(info(f.actions)).toContain('mcp: "docs" failed — toggle fixture');
    f.orchestrator.restartServer("docs");
    await settle(f.actions, 2);
    expect(f.manager.restartServer).toHaveBeenCalledOnce();
    expect(f.refreshMcp).toHaveBeenCalledOnce();
    expect(getConfig().mcp.servers[0]?.enabled).toBe(false);
  });

  it("starts one refresh timer, preserves detail on ticks, and cancels it on shutdown", () => {
    vi.useFakeTimers();
    persistMcpServer(server());
    const f = mount();
    f.orchestrator.openDetail("docs");
    f.orchestrator.startAutoRefresh();
    f.orchestrator.startAutoRefresh();
    expect(vi.getTimerCount()).toBe(1);
    expect(f.manager.listStatuses).toHaveBeenCalledTimes(3); // open detail, rows and refreshed detail.
    vi.advanceTimersByTime(200);
    expect(f.actions.filter((action) => action.type === "mcp_detail_refreshed")).toHaveLength(3);
    const calls = f.manager.listStatuses.mock.calls.length;
    f.orchestrator.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(f.manager.listStatuses).toHaveBeenCalledTimes(calls);
  });
});
