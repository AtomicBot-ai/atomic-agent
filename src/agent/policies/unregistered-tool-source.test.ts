import { describe, expect, it } from "vitest";

import { unregisteredToolSource } from "./unregistered-tool-source.js";

const CATALOG = ["os.fs.read", "os.fs.grep", "memory.procedures.recall", "mcp.resource.list"];

function source(emitted: string, advertised: string[], registered: string[]) {
  return unregisteredToolSource({ emitted, advertised, catalog: CATALOG, registered });
}

describe("unregisteredToolSource (ATO-2423)", () => {
  it("says the prompt showed a tool the registry lacks", () => {
    expect(source("os.fs.write", ["os.fs.read", "os.fs.write"], ["os.fs.read"])).toBe("prompt_advertised");
    // The same name in another spelling is the same advertised tool.
    expect(source("OS_FS_WRITE", ["os.fs.write"], ["os.fs.read"])).toBe("prompt_advertised");
    expect(source("mcp.github.create_issue", ["mcp.github.create_issue"], [])).toBe("prompt_advertised");
  });

  it("says a catalog tool the prompt did not show is gated off", () => {
    expect(source("memory.procedures.recall", ["os.fs.read"], ["os.fs.read"])).toBe("gated_off");
  });

  it("tells an MCP name of a missing server from one of a server that is there", () => {
    expect(source("mcp.github.create_issue", [], ["os.fs.read"])).toBe("mcp_server_missing");
    expect(source("mcp.github.create_issue", [], ["mcp.github.list_issues"])).toBe("mcp_tool_missing");
    expect(source("mcp__github__create_issue", [], ["mcp.github.list_issues"])).toBe("mcp_tool_missing");
    // Our own `mcp.resource.*` tools are not a server named `resource`.
    expect(source("mcp.resource.write", [], ["mcp.resource.list"])).toBe("mcp_server_missing");
  });

  it("says an invented name is in no catalog", () => {
    expect(source("function_name", ["os.fs.read"], ["os.fs.read"])).toBe("not_in_catalog");
    expect(source("os.grep", ["os.fs.grep"], ["os.fs.grep"])).toBe("not_in_catalog");
  });
});
