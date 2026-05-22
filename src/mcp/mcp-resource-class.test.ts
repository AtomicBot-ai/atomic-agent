import { describe, expect, it } from "vitest";

import {
  MCP_TOOL_PREFIX,
  createMcpResourceClassResolver,
  qualifyMcpToolName,
  splitMcpToolName,
} from "./mcp-resource-class.js";
import type { McpTrustLevel } from "./mcp-types.js";

describe("qualifyMcpToolName", () => {
  it("joins server and rawName with the literal mcp. prefix", () => {
    expect(qualifyMcpToolName("github", "create_issue")).toBe(
      "mcp.github.create_issue",
    );
  });

  it("preserves dots inside the raw tool name", () => {
    expect(qualifyMcpToolName("fs", "os.read_file")).toBe(
      "mcp.fs.os.read_file",
    );
  });

  it("uses the documented prefix constant", () => {
    expect(MCP_TOOL_PREFIX).toBe("mcp.");
  });
});

describe("splitMcpToolName", () => {
  it("splits a well-formed qualified name", () => {
    expect(splitMcpToolName("mcp.github.create_issue")).toEqual({
      server: "github",
      rawName: "create_issue",
    });
  });

  it("keeps a dotted raw name intact (only first dot after prefix is consumed)", () => {
    expect(splitMcpToolName("mcp.fs.os.read_file")).toEqual({
      server: "fs",
      rawName: "os.read_file",
    });
  });

  it("returns null for non-MCP names", () => {
    expect(splitMcpToolName("os.fs.read")).toBeNull();
    expect(splitMcpToolName("reply")).toBeNull();
    expect(splitMcpToolName("")).toBeNull();
  });

  it("returns null when the server name is empty", () => {
    expect(splitMcpToolName("mcp..tool")).toBeNull();
  });

  it("returns null when there is no rawName segment", () => {
    expect(splitMcpToolName("mcp.github.")).toBeNull();
    expect(splitMcpToolName("mcp.github")).toBeNull();
  });
});

describe("createMcpResourceClassResolver", () => {
  function buildTrust(entries: Array<[string, McpTrustLevel]>): Map<string, McpTrustLevel> {
    return new Map(entries);
  }

  it("returns null for non-MCP tool names (falls through to static table)", () => {
    const resolve = createMcpResourceClassResolver(buildTrust([]));
    expect(resolve("os.fs.read")).toBeNull();
    expect(resolve("reply")).toBeNull();
    expect(resolve("memory.notes.store")).toBeNull();
  });

  it("maps pure_read trust to pure_read class", () => {
    const resolve = createMcpResourceClassResolver(
      buildTrust([["docs", "pure_read"]]),
    );
    expect(resolve("mcp.docs.search")).toBe("pure_read");
  });

  it("maps approval_gated trust to approval_gated class", () => {
    const resolve = createMcpResourceClassResolver(
      buildTrust([["github", "approval_gated"]]),
    );
    expect(resolve("mcp.github.create_issue")).toBe("approval_gated");
  });

  it("returns approval_gated for unknown servers (safe default — never null)", () => {
    const resolve = createMcpResourceClassResolver(buildTrust([]));
    expect(resolve("mcp.hallucinated.tool")).toBe("approval_gated");
  });

  it("isolates trust per server", () => {
    const resolve = createMcpResourceClassResolver(
      buildTrust([
        ["docs", "pure_read"],
        ["github", "approval_gated"],
      ]),
    );
    expect(resolve("mcp.docs.search")).toBe("pure_read");
    expect(resolve("mcp.github.create_issue")).toBe("approval_gated");
  });
});
