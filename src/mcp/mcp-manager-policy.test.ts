import { afterEach, describe, expect, it, vi } from "vitest";

import { setDynamicResourceClassResolver } from "../agent/tool-resource-class.js";
import { mergePolicySources } from "../policy/policy-loader.js";
import { mcpServerPolicy } from "../policy/policy-enforce.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { McpServerCatalog, McpServerConfig } from "./mcp-types.js";

const CONNECTED: string[] = [];

vi.mock("./mcp-client.js", () => {
  class FakeMcpClient {
    constructor(private readonly config: McpServerConfig) {}
    get name() {
      return this.config.name;
    }
    async connect(): Promise<void> {
      CONNECTED.push(this.config.name);
    }
    async close(): Promise<void> {}
    getCatalog(): McpServerCatalog {
      return { server: this.config.name, tools: [], resources: [], prompts: [] };
    }
  }
  return { McpClient: FakeMcpClient };
});

const { McpManager } = await import("./mcp-manager.js");

function server(name: string, url?: string): McpServerConfig {
  return url
    ? { name, enabled: true, transport: { kind: "streamable_http", url } }
    : { name, enabled: true, transport: { kind: "stdio", command: "/bin/true" } };
}

function managerWith(allowlist: unknown, configs: McpServerConfig[]) {
  const policy = mergePolicySources([{
    status: { kind: "system", location: "test", state: "loaded" },
    file: parsePolicyFile({ mcpAllowlist: allowlist }),
  }]);
  const warn = vi.fn();
  const logger = { info: () => {}, warn, error: () => {}, debug: () => {} } as never;
  const mgr = new McpManager(configs, {
    toolRegistry: new ToolRegistry(),
    logger,
    serverPolicy: (config) => mcpServerPolicy(policy, config),
  });
  return { mgr, warn };
}

describe("McpManager with an organization MCP allowlist (ATO-587)", () => {
  afterEach(() => {
    CONNECTED.length = 0;
    setDynamicResourceClassResolver(null);
  });

  it("connects listed servers and keeps an unlisted one down with the reason", async () => {
    const { mgr, warn } = managerWith(
      { servers: ["github", "https://mcp.corp.test/*"] },
      [server("github"), server("corp", "https://mcp.corp.test/mcp"), server("evil", "https://evil.test/mcp")],
    );
    await mgr.start();
    expect(CONNECTED).toEqual(["github", "corp"]);
    const evil = mgr.listStatuses().find((s) => s.name === "evil");
    expect(evil?.state).toBe("down");
    expect(evil?.lastError).toContain("not on your organization's allowlist");
    expect(warn).toHaveBeenCalledWith("mcp.server_not_on_allowlist", { server: "evil", blocked: true });
  });

  it("refuses a live-added and a restarted server too", async () => {
    const { mgr } = managerWith(["github"], []);
    await mgr.addServerLive(server("evil"));
    await mgr.restartServer("evil");
    expect(CONNECTED).toEqual([]);
    expect(mgr.listStatuses()[0]?.state).toBe("down");
  });

  it("warn-only mode connects the unlisted server and logs it", async () => {
    const { mgr, warn } = managerWith({ servers: [], warnOnly: true }, [server("evil")]);
    await mgr.start();
    expect(CONNECTED).toEqual(["evil"]);
    expect(warn).toHaveBeenCalledWith("mcp.server_not_on_allowlist", { server: "evil", blocked: false });
  });
});
