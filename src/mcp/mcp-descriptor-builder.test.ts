import { describe, expect, it } from "vitest";

import type { ToolDescriptor } from "../prompt/stable-prefix.js";

import {
  buildMcpToolDescriptor,
  buildMcpToolDescriptors,
  mergeMcpDescriptors,
} from "./mcp-descriptor-builder.js";
import type { McpToolMeta } from "./mcp-types.js";

function metaOf(
  server: string,
  rawName: string,
  overrides: Partial<McpToolMeta> = {},
): McpToolMeta {
  return {
    server,
    rawName,
    qualifiedName: `mcp.${server}.${rawName}`,
    description: "",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

describe("buildMcpToolDescriptor", () => {
  it("ships every MCP tool as tier 'frequent' so the full schema lands in the stable prefix", () => {
    const d = buildMcpToolDescriptor(metaOf("github", "create_issue"));
    expect(d.tier).toBe("frequent");
  });

  it("prefixes the summary with `[mcp:<server>]`", () => {
    const d = buildMcpToolDescriptor(
      metaOf("github", "create_issue", { description: "Open a new issue." }),
    );
    expect(d.summary).toBe("[mcp:github] Open a new issue.");
  });

  it("falls back to a synthetic summary when description is empty", () => {
    const d = buildMcpToolDescriptor(metaOf("github", "list_repos"));
    expect(d.summary).toBe("[mcp:github] MCP list_repos on github");
  });

  it("collapses whitespace and newlines in the description", () => {
    const d = buildMcpToolDescriptor(
      metaOf("docs", "search", { description: "first line\n  second line  " }),
    );
    expect(d.summary).toBe("[mcp:docs] first line second line");
  });

  it("uses the qualified name as descriptor name", () => {
    const d = buildMcpToolDescriptor(metaOf("github", "create_issue"));
    expect(d.name).toBe("mcp.github.create_issue");
  });

  it("renders argsSchema as compact JSON", () => {
    const d = buildMcpToolDescriptor(
      metaOf("docs", "search", {
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      }),
    );
    expect(d.argsSchema).toContain('"properties"');
    expect(d.argsSchema).toContain('"q"');
  });

  it("renders empty schema as `{}`", () => {
    const d = buildMcpToolDescriptor(
      metaOf("docs", "noop", { inputSchema: null }),
    );
    expect(d.argsSchema).toBe("{}");
  });
});

describe("buildMcpToolDescriptors", () => {
  it("returns an empty array for empty input", () => {
    expect(buildMcpToolDescriptors([])).toEqual([]);
  });

  it("sorts deterministically by (server, rawName) — KV-cache stability", () => {
    const a = buildMcpToolDescriptors([
      metaOf("z", "b"),
      metaOf("a", "z"),
      metaOf("a", "a"),
      metaOf("m", "k"),
    ]);
    expect(a.map((d) => d.name)).toEqual([
      "mcp.a.a",
      "mcp.a.z",
      "mcp.m.k",
      "mcp.z.b",
    ]);
  });

  it("is byte-stable across calls with reshuffled input", () => {
    const tools = [metaOf("docs", "search"), metaOf("github", "list_issues")];
    const a = buildMcpToolDescriptors(tools);
    const b = buildMcpToolDescriptors([...tools].reverse());
    expect(a).toEqual(b);
  });
});

describe("mergeMcpDescriptors", () => {
  const base: ToolDescriptor[] = [
    { name: "reply", summary: "reply", argsSchema: "{}", tier: "frequent" },
    { name: "os.fs.read", summary: "read", argsSchema: "{}", tier: "frequent" },
  ];

  it("returns a copy of base when mcp list is empty", () => {
    const out = mergeMcpDescriptors(base, []);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });

  it("appends MCP descriptors after base entries", () => {
    const mcp: ToolDescriptor[] = [
      { name: "mcp.docs.search", summary: "[mcp:docs]", argsSchema: "{}", tier: "frequent" },
    ];
    const out = mergeMcpDescriptors(base, mcp);
    expect(out.map((d) => d.name)).toEqual([
      "reply",
      "os.fs.read",
      "mcp.docs.search",
    ]);
  });

  it("MCP entry wins on name collision (dynamic side surfaced)", () => {
    const collidingBase: ToolDescriptor[] = [
      ...base,
      {
        name: "mcp.docs.search",
        summary: "static-stub",
        argsSchema: "{}",
        tier: "frequent",
      },
    ];
    const mcp: ToolDescriptor[] = [
      {
        name: "mcp.docs.search",
        summary: "[mcp:docs] real summary",
        argsSchema: '{"q":"string"}',
        tier: "frequent",
      },
    ];
    const out = mergeMcpDescriptors(collidingBase, mcp);
    const colliding = out.filter((d) => d.name === "mcp.docs.search");
    expect(colliding).toHaveLength(1);
    expect(colliding[0]!.summary).toBe("[mcp:docs] real summary");
    expect(colliding[0]!.tier).toBe("frequent");
  });
});
