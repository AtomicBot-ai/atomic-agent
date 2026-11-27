import { describe, expect, it } from "vitest";

import {
  BUILTIN_TOOLS_PART,
  loadedToolsParts,
  prefixOffersToolSearch,
  stablePrefixParts,
} from "./prompt-breakdown.js";
import {
  buildStablePrefix,
  formatToolForLoadedTail,
  type CapabilitiesSummary,
  type ToolDescriptor,
} from "./stable-prefix.js";
import { estimateTokens } from "./token-budget.js";

const CAPS: CapabilitiesSummary = {
  platform: "linux",
  arch: "x64",
  browserChannel: "none",
  workingDir: "/repo",
  hasClipboard: false,
  hasWmctrl: false,
  hasNotifications: false,
};

const READ: ToolDescriptor = {
  name: "os.fs.read",
  summary: "Read a file.",
  argsSchema: "{ path: string }",
};

function mcpTool(server: string, name: string, schemaWords = 4): ToolDescriptor {
  return {
    name: `mcp.${server}.${name}`,
    summary: `[mcp:${server}] ${name} on ${server}`,
    argsSchema: `{ ${Array.from({ length: schemaWords }, (_, i) => `field${i}: string`).join(", ")} }`,
  };
}

function prefix(tools: ToolDescriptor[]): string {
  return buildStablePrefix({ toolDescriptors: tools, capabilities: CAPS, skillCatalog: [] });
}

function sum(parts: readonly { tokens: number }[]): number {
  return parts.reduce((a, p) => a + p.tokens, 0);
}

describe("stablePrefixParts (ATO-2355)", () => {
  it("splits a real prefix by section and the tool catalog by MCP server", () => {
    const text = prefix([
      READ,
      mcpTool("github", "create_issue"),
      mcpTool("github", "list_prs"),
      mcpTool("slack", "post"),
    ]);
    const total = estimateTokens(text);
    const parts = stablePrefixParts(text, total);
    expect(parts.map((p) => p.label)).toEqual([
      "persona",
      "rules",
      "skills",
      BUILTIN_TOOLS_PART,
      "mcp github",
      "mcp slack",
      "capabilities",
      "instructions",
    ]);
    expect(parts.find((p) => p.label === "mcp github")?.mcpServer).toBe("github");
    expect(parts.find((p) => p.label === BUILTIN_TOOLS_PART)?.mcpServer).toBeUndefined();
    expect(sum(parts)).toBe(total);
  });

  it("charges a bigger server more than a smaller one", () => {
    const text = prefix([READ, mcpTool("big", "a", 60), mcpTool("big", "b", 60), mcpTool("small", "c", 2)]);
    const parts = stablePrefixParts(text, estimateTokens(text));
    const big = parts.find((p) => p.mcpServer === "big")!.tokens;
    const small = parts.find((p) => p.mcpServer === "small")!.tokens;
    expect(big).toBeGreaterThan(small * 10);
  });

  it("keeps the catalog as one built-in row when no server is mounted", () => {
    const text = prefix([READ]);
    const parts = stablePrefixParts(text, estimateTokens(text));
    expect(parts.filter((p) => p.label === BUILTIN_TOOLS_PART)).toHaveLength(1);
    expect(parts.some((p) => p.mcpServer !== undefined)).toBe(false);
  });

  it("returns nothing for an empty prefix", () => {
    expect(stablePrefixParts("", 5000)).toEqual([]);
  });
});

describe("loadedToolsParts (ATO-2355)", () => {
  const block = (tools: ToolDescriptor[]): string =>
    tools.map((t) => formatToolForLoadedTail(t.name, t.summary, t.argsSchema)).join("\n\n");

  /** The check the issue names: two servers, two rows, sum = loaded tools. */
  it("gives two MCP servers two rows that add up to the loaded-tools figure", () => {
    const body = block([mcpTool("github", "create_issue", 20), mcpTool("slack", "post", 10)]);
    const total = estimateTokens(body);
    const tail = [
      "### conversation",
      "user: hi",
      "",
      "### loaded-tools",
      body,
      "",
      "### notice",
      "x",
    ].join("\n");
    const parts = loadedToolsParts(tail, total);
    expect(parts.map((p) => p.mcpServer)).toEqual(["github", "slack"]);
    expect(sum(parts)).toBe(total);
  });

  it("reads the last loaded-tools block, not one quoted in the transcript", () => {
    const body = block([mcpTool("github", "create_issue")]);
    const tail = [
      "### conversation",
      "user: look",
      "### loaded-tools",
      "- mcp.fake.tool — quoted",
      "",
      "### loaded-tools",
      body,
    ].join("\n");
    const parts = loadedToolsParts(tail, 100);
    expect(parts.map((p) => p.mcpServer)).toEqual(["github"]);
  });

  it("stays empty when only built-in tools are loaded", () => {
    const tail = `### conversation\nu\n\n### loaded-tools\n${block([READ])}\n`;
    expect(loadedToolsParts(tail, 50)).toEqual([]);
  });

  it("stays empty without a loaded-tools block", () => {
    expect(loadedToolsParts("### conversation\nhello", 50)).toEqual([]);
  });
});

describe("prefixOffersToolSearch", () => {
  it("is true only when tool.search is in the catalog", () => {
    const search: ToolDescriptor = { name: "tool.search", summary: "Find a tool.", argsSchema: "{ query: string }" };
    expect(prefixOffersToolSearch(prefix([READ, search]))).toBe(true);
    expect(prefixOffersToolSearch(prefix([READ]))).toBe(false);
  });
});
