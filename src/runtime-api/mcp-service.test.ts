import { describe, expect, it, vi } from "vitest";

import type { McpServerConfig } from "../mcp/index.js";
import { RuntimeApiError } from "./runtime-api-error.js";
import {
  addMcpServer,
  listMcp,
  refreshMcp,
  removeMcpServer,
  type McpServiceDeps,
} from "./mcp-service.js";

function fakeConfig(name = "github"): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: { kind: "stdio", command: "npx", args: ["-y", "srv"] },
  } as McpServerConfig;
}

function makeDeps(overrides: Partial<McpServiceDeps> = {}): McpServiceDeps {
  return {
    mcpManager: {
      listStatuses: vi.fn(() => [{ name: "github", state: "up" }] as never),
      listCatalogs: vi.fn(() => [] as never),
      addServerLive: vi.fn(async () => ({ added: true, tools: [] as never })),
      removeServerLive: vi.fn(async () => ({ removed: true, tools: [] })),
    },
    refreshMcp: vi.fn(async () => {}),
    persistServer: vi.fn(),
    removeServerConfig: vi.fn(),
    ...overrides,
  };
}

describe("mcp-service facade", () => {
  it("lists servers + catalogs", () => {
    const deps = makeDeps();
    const result = listMcp(deps);
    expect(result.servers).toHaveLength(1);
    expect(result.catalogs).toEqual([]);
  });

  it("persists, connects live, and refreshes on add", async () => {
    const deps = makeDeps();
    const cfg = fakeConfig();
    const result = await addMcpServer(deps, cfg);
    expect(deps.persistServer).toHaveBeenCalledWith(cfg);
    expect(deps.mcpManager.addServerLive).toHaveBeenCalledWith(cfg);
    expect(deps.refreshMcp).toHaveBeenCalled();
    expect(result.added).toBe(true);
  });

  it("maps a persist failure to invalid_request", async () => {
    const deps = makeDeps({
      persistServer: vi.fn(() => {
        throw new Error("duplicate name");
      }),
    });
    await expect(addMcpServer(deps, fakeConfig())).rejects.toBeInstanceOf(
      RuntimeApiError,
    );
    expect(deps.mcpManager.addServerLive).not.toHaveBeenCalled();
  });

  it("degrades gracefully when live connect fails after persist", async () => {
    const deps = makeDeps({
      mcpManager: {
        listStatuses: vi.fn(() => [] as never),
        listCatalogs: vi.fn(() => [] as never),
        addServerLive: vi.fn(async () => {
          throw new Error("connect timeout");
        }),
        removeServerLive: vi.fn(async () => ({ removed: true, tools: [] })),
      },
    });
    const result = await addMcpServer(deps, fakeConfig());
    expect(deps.persistServer).toHaveBeenCalled();
    expect(result).toEqual({ added: false, tools: [] });
  });

  it("removes from config then live", async () => {
    const deps = makeDeps();
    const result = await removeMcpServer(deps, "github");
    expect(deps.removeServerConfig).toHaveBeenCalledWith("github");
    expect(deps.mcpManager.removeServerLive).toHaveBeenCalledWith("github");
    expect(result.removed).toBe(true);
  });

  it("maps a missing server on remove to not_found", async () => {
    const deps = makeDeps({
      removeServerConfig: vi.fn(() => {
        throw new Error("not found");
      }),
    });
    await expect(removeMcpServer(deps, "ghost")).rejects.toBeInstanceOf(
      RuntimeApiError,
    );
  });

  it("rejects an empty add config", async () => {
    const deps = makeDeps();
    await expect(
      addMcpServer(deps, null as unknown as McpServerConfig),
    ).rejects.toBeInstanceOf(RuntimeApiError);
  });

  it("refreshes the live catalog", async () => {
    const deps = makeDeps();
    await refreshMcp(deps);
    expect(deps.refreshMcp).toHaveBeenCalled();
  });
});
