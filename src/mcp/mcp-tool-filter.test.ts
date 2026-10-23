import { describe, expect, it } from "vitest";

import { McpClient } from "./mcp-client.js";
import { isMcpToolEnabled } from "./mcp-tool-filter.js";
import type { McpServerConfig } from "./mcp-types.js";

describe("isMcpToolEnabled", () => {
  it("offers every tool when no list is set", () => {
    expect(isMcpToolEnabled({}, "create_issue")).toBe(true);
  });

  it("offers only the allowlisted tools when enabledTools is set", () => {
    const config = { enabledTools: ["get_issue", "list_issues"] };
    expect(isMcpToolEnabled(config, "get_issue")).toBe(true);
    expect(isMcpToolEnabled(config, "create_issue")).toBe(false);
    expect(isMcpToolEnabled({ enabledTools: [] }, "get_issue")).toBe(false);
  });

  it("applies disabledTools on top of the allowlist", () => {
    expect(isMcpToolEnabled({ disabledTools: ["delete_repo"] }, "delete_repo")).toBe(false);
    expect(isMcpToolEnabled({ disabledTools: ["delete_repo"] }, "get_issue")).toBe(true);
    expect(
      isMcpToolEnabled({ enabledTools: ["get_issue"], disabledTools: ["get_issue"] }, "get_issue"),
    ).toBe(false);
  });
});

describe("McpClient discovery", () => {
  function clientWithTools(config: Partial<McpServerConfig>, names: string[]): McpClient {
    const client = new McpClient({
      name: "github",
      enabled: true,
      transport: { kind: "stdio", command: "unused" },
      ...config,
    });
    // A connected SDK client stand-in: only the discovery calls are used.
    (client as unknown as { client: unknown }).client = {
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => ({ tools: names.map((name) => ({ name })) }),
    };
    return client;
  }

  it("drops turned-off tools before they reach the catalog", async () => {
    const client = clientWithTools(
      { enabledTools: ["get_issue", "list_issues", "delete_repo"], disabledTools: ["delete_repo"] },
      ["get_issue", "list_issues", "create_issue", "delete_repo"],
    );
    const catalog = await client.refreshCatalog();
    expect(catalog.tools.map((t) => t.qualifiedName)).toEqual([
      "mcp.github.get_issue",
      "mcp.github.list_issues",
    ]);
  });

  it("keeps every tool without a filter", async () => {
    const catalog = await clientWithTools({}, ["get_issue", "create_issue"]).refreshCatalog();
    expect(catalog.tools.map((t) => t.rawName)).toEqual(["get_issue", "create_issue"]);
  });
});
