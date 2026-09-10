import { describe, expect, it } from "vitest";

import {
  COMPOSIO_SERVER_NAME,
  buildComposioServerConfig,
} from "./build-composio-server-config.js";
import { MCP_SERVER_NAME_RE } from "../mcp/mcp-types.js";

const SESSION = {
  mcpUrl: "https://backend.composio.dev/tool_router/trs_abc/mcp",
};

describe("buildComposioServerConfig", () => {
  it("produces a streamable-http server carrying the key as x-api-key", () => {
    const cfg = buildComposioServerConfig({ session: SESSION, apiKey: "ak_9" });
    expect(cfg.name).toBe(COMPOSIO_SERVER_NAME);
    expect(cfg.enabled).toBe(true);
    expect(cfg.transport).toEqual({
      kind: "streamable_http",
      url: SESSION.mcpUrl,
      headers: { "x-api-key": "ak_9" },
    });
  });

  it("stays at the fail-closed approval_gated trust level", () => {
    // Discovery still flows without prompting: the adapter skips the
    // gate for tools the server annotates readOnlyHint, which is how
    // Composio tags COMPOSIO_SEARCH_TOOLS / GET_TOOL_SCHEMAS. Loosening
    // trust here would also un-gate MULTI_EXECUTE and MANAGE_CONNECTIONS.
    expect(
      buildComposioServerConfig({ session: SESSION, apiKey: "ak" }).trust,
    ).toBe("approval_gated");
  });

  it("uses a server name the MCP namespace accepts", () => {
    // Tools are addressed as mcp.composio.<TOOL>; an invalid name would
    // break tool dispatch and the GBNF string literal alike.
    expect(MCP_SERVER_NAME_RE.test(COMPOSIO_SERVER_NAME)).toBe(true);
  });
});
