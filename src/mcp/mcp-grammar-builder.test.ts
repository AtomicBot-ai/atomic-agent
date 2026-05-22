import { describe, expect, it } from "vitest";

import { applyMcpToolNameRule, buildMcpToolNameRule } from "./mcp-grammar-builder.js";
import type { McpToolMeta } from "./mcp-types.js";

function metaOf(server: string, rawName: string): McpToolMeta {
  return {
    server,
    rawName,
    qualifiedName: `mcp.${server}.${rawName}`,
    description: "",
    inputSchema: { type: "object" },
  };
}

describe("buildMcpToolNameRule", () => {
  it("returns null when the input is empty", () => {
    expect(buildMcpToolNameRule([])).toBeNull();
  });

  it("emits a single literal alternation for one tool", () => {
    const rule = buildMcpToolNameRule([metaOf("github", "create_issue")]);
    expect(rule).toBe('mcp-server-tool ::= "\\"mcp.github.create_issue\\""');
  });

  it("sorts qualified names deterministically (KV-cache stability)", () => {
    const a = buildMcpToolNameRule([
      metaOf("z", "tool_b"),
      metaOf("a", "tool_a"),
      metaOf("m", "tool_m"),
    ]);
    const b = buildMcpToolNameRule([
      metaOf("a", "tool_a"),
      metaOf("z", "tool_b"),
      metaOf("m", "tool_m"),
    ]);
    expect(a).toBe(b);
    expect(a).toContain('"\\"mcp.a.tool_a\\"" | "\\"mcp.m.tool_m\\"" | "\\"mcp.z.tool_b\\""');
  });

  it("deduplicates collisions (same qualifiedName twice → single literal)", () => {
    const rule = buildMcpToolNameRule([
      metaOf("github", "create_issue"),
      metaOf("github", "create_issue"),
    ]);
    expect(rule).toBe('mcp-server-tool ::= "\\"mcp.github.create_issue\\""');
  });

  it("produces byte-stable output for identical input", () => {
    const tools = [metaOf("docs", "search"), metaOf("github", "list_issues")];
    const a = buildMcpToolNameRule(tools);
    const b = buildMcpToolNameRule([...tools]);
    expect(a).toBe(b);
  });
});

describe("applyMcpToolNameRule", () => {
  const baseGrammar = [
    'root ::= tool-call-array',
    'tool-name ::= browser-tool | mcp-server-tool | "\\"reply\\""',
    'mcp-server-tool ::= "\\"mcp." [a-z0-9-]+ "." [a-zA-Z0-9._-]+ "\\""',
    'browser-tool ::= "\\"browser.open\\""',
  ].join("\n");

  it("returns the grammar unchanged when rule is null", () => {
    expect(applyMcpToolNameRule(baseGrammar, null)).toBe(baseGrammar);
  });

  it("replaces the static placeholder with the dynamic rule", () => {
    const dyn = 'mcp-server-tool ::= "\\"mcp.github.create_issue\\""';
    const out = applyMcpToolNameRule(baseGrammar, dyn);
    expect(out).toContain('mcp-server-tool ::= "\\"mcp.github.create_issue\\""');
    expect(out).not.toContain('[a-z0-9-]+ "." [a-zA-Z0-9._-]+');
  });

  it("appends the rule when the placeholder is missing (fail-open)", () => {
    const grammarWithoutPlaceholder = [
      'root ::= tool-call-array',
      'browser-tool ::= "\\"browser.open\\""',
    ].join("\n");
    const dyn = 'mcp-server-tool ::= "\\"mcp.github.create_issue\\""';
    const out = applyMcpToolNameRule(grammarWithoutPlaceholder, dyn);
    expect(out.endsWith(dyn + "\n")).toBe(true);
  });

  it("is idempotent — applying the same rule twice yields the same output", () => {
    const dyn = 'mcp-server-tool ::= "\\"mcp.docs.search\\""';
    const once = applyMcpToolNameRule(baseGrammar, dyn);
    const twice = applyMcpToolNameRule(once, dyn);
    expect(once).toBe(twice);
  });
});
