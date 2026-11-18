import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/tool-registry.js";
import { resolveToolName } from "./tool-name-resolution.js";
import { closestToolNames, unknownToolResult } from "./policies/unknown-tool.js";

function registry(...names: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names) {
    reg.register({
      name,
      description: name,
      readonly: true,
      run: async () => ({
        tool: name,
        status: "ok" as const,
        summary: "",
        details: {},
        truncated: false,
      }),
    });
  }
  return reg;
}

const REG = registry(
  "fusion.delegate",
  "os.fs.write",
  "os.fs.trash",
  "reply",
);

describe("resolveToolName", () => {
  it("returns an exact name untouched", () => {
    expect(resolveToolName("os.fs.write", REG)).toBe("os.fs.write");
    expect(resolveToolName("reply", REG)).toBe("reply");
  });

  it("fixes the separator a model got one underscore short", () => {
    // The observed failure: `fusion.delegate` travels the OpenAI wire as
    // `fusion__delegate`, the model wrote it from memory as
    // `fusion_delegate`, and the turn died on the membership check.
    expect(resolveToolName("fusion_delegate", REG)).toBe("fusion.delegate");
    expect(resolveToolName("os_fs_write", REG)).toBe("os.fs.write");
  });

  it("resolves a name that arrived still escaped", () => {
    // The text-JSON fallback path does not run `nameUnescape`.
    expect(resolveToolName("fusion__delegate", REG)).toBe("fusion.delegate");
  });

  it("resolves case on its own and over a fixed separator", () => {
    expect(resolveToolName("OS.FS.WRITE", REG)).toBe("os.fs.write");
    expect(resolveToolName("Fusion_Delegate", REG)).toBe("fusion.delegate");
  });

  it("refuses to guess between near neighbours", () => {
    // Not fuzzy matching. `os.fs.write` must never resolve to
    // `os.fs.trash` because the two are close — a tool that deletes is
    // one edit away from a tool that writes.
    expect(resolveToolName("os.fs.writ", REG)).toBeNull();
    expect(resolveToolName("os.fs.wrote", REG)).toBeNull();
    expect(resolveToolName("fs.write", REG)).toBeNull();
  });

  it("returns null for a name that is nothing like a registered tool", () => {
    expect(resolveToolName("summon_daemon", REG)).toBeNull();
    expect(resolveToolName("", REG)).toBeNull();
  });
});

// ATO-1674: near misses on MCP tools (added in v0.7/v0.8) and on the
// wrapping a model or its chat template puts around a name.
const MCP_REG = registry(
  "os.fs.read",
  "os.fs.write",
  "os.web.search",
  "mcp.resource.list",
  "mcp.github.create_issue",
  "mcp.github.list_issues",
  "mcp.brave-search.brave_web_search",
  "mcp.search.web_search",
);

describe("resolveToolName on separator and wrapping forms", () => {
  it("resolves an MCP name whose own part has underscores, written all single-underscore", () => {
    // `_` → `.` alone gives `mcp.github.create.issue`, which is not a tool.
    expect(resolveToolName("mcp_github_create_issue", MCP_REG)).toBe("mcp.github.create_issue");
  });

  it("resolves a server name written with `_` for its `-`", () => {
    expect(resolveToolName("mcp__brave_search__brave_web_search", MCP_REG)).toBe(
      "mcp.brave-search.brave_web_search",
    );
    expect(resolveToolName("mcp.brave_search.brave-web-search", MCP_REG)).toBe(
      "mcp.brave-search.brave_web_search",
    );
  });

  it("drops the `functions.` namespace of OpenAI-style templates", () => {
    expect(resolveToolName("functions.os.fs.read", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("functions__mcp__github__list_issues", MCP_REG)).toBe("mcp.github.list_issues");
  });

  it("drops quotes, an empty call, trailing punctuation and a chat-template tail", () => {
    expect(resolveToolName("`os.fs.read`", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName('"os.fs.read"', MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("os.fs.read()", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("os.fs.read:", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("os.fs.read<|channel|>commentary", MCP_REG)).toBe("os.fs.read");
  });
});

describe("resolveToolName with part of the real name missing", () => {
  // Never resolved, however likely the match: the short form can be
  // meant for a different tool, and a different tool can act outside
  // the read roots or without approval. The error result names the
  // candidates and the model picks (ATO-1674).
  const SHORT_REG = registry(
    "os.fs.read",
    "os.fs.write",
    "github.issue.create",
    "mcp.github.create_issue",
    "mcp.filesystem.write_file",
    "mcp.filesystem.delete_file",
    "mcp.composio.GITHUB_CREATE_ISSUE",
  );
  const names = SHORT_REG.list().map((definition) => definition.name);

  it.each([
    ["write_file", ["mcp.filesystem.write_file", "os.fs.write"]],
    ["delete_file", ["mcp.filesystem.delete_file"]],
    ["github.create_issue", ["mcp.github.create_issue", "github.issue.create"]],
    ["create_issue", ["mcp.github.create_issue"]],
    ["mcp.create_issue", ["mcp.github.create_issue"]],
  ] as const)("%s is not resolved and the error result names the candidates", (emitted, named) => {
    expect(resolveToolName(emitted, SHORT_REG)).toBeNull();
    const suggestions = closestToolNames(emitted, names);
    for (const candidate of named) expect(suggestions).toContain(candidate);
    const refused = unknownToolResult(emitted, names);
    expect(refused).toMatchObject({ tool: emitted, status: "error" });
    expect(refused.details).toMatchObject({ unregisteredTool: true });
    for (const candidate of named) expect(refused.details?.suggestions).toContain(candidate);
  });

  it("does not resolve a namespace-less Composio name either", () => {
    expect(resolveToolName("GITHUB_CREATE_ISSUE", SHORT_REG)).toBeNull();
  });

  it("refuses two tools that share one spelling", () => {
    const collide = registry("mcp.a.b_c", "mcp.a_b.c");
    expect(resolveToolName("mcp_a_b_c", collide)).toBeNull();
    expect(resolveToolName("mcp-a-b-c", collide)).toBeNull();
    // Each exact name still resolves to itself.
    expect(resolveToolName("mcp.a.b_c", collide)).toBe("mcp.a.b_c");
    expect(resolveToolName("mcp.a_b.c", collide)).toBe("mcp.a_b.c");
  });

  it("still refuses a name that is a different tool, not a different spelling", () => {
    expect(resolveToolName("mcp.github.create_issues", MCP_REG)).toBeNull();
    expect(resolveToolName("mcp.github.close_issue", MCP_REG)).toBeNull();
    expect(resolveToolName("os.fs.writ", MCP_REG)).toBeNull();
    expect(resolveToolName("functions.", MCP_REG)).toBeNull();
    expect(resolveToolName("()", MCP_REG)).toBeNull();
  });
});
