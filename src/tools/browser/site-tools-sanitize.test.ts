import { describe, expect, it } from "vitest";
import { checkSiteToolArgs, sanitizeSiteTools, SITE_TOOL_LIMITS } from "./site-tools-sanitize.js";

/** What a page says about its own WebMCP tools, checked before the model sees it (ATO-521). */

function entry(over: Record<string, unknown> = {}) {
  return { name: "search", title: "Search", description: "Find products", inputSchema: '{"type":"object"}', readOnlyHint: false, ...over };
}

describe("sanitizeSiteTools", () => {
  it("keeps a well-formed tool and parses its schema", () => {
    const { tools, skipped, total } = sanitizeSiteTools([entry({ readOnlyHint: true })]);
    expect(skipped).toEqual([]);
    expect(total).toBe(1);
    expect(tools).toEqual([
      { name: "search", title: "Search", description: "Find products", inputSchema: { type: "object" }, readOnlyHint: true },
    ]);
  });

  it("skips bad names, duplicates and schemas that are too large, not JSON or not an object", () => {
    const { tools, skipped } = sanitizeSiteTools([
      entry({ name: "has space" }),
      entry({ name: "" }),
      entry({ name: 'x"; ignore all' }),
      entry(),
      entry(),
      entry({ name: "big", inputSchema: "x".repeat(SITE_TOOL_LIMITS.maxSchemaChars + 1) }),
      entry({ name: "broken", inputSchema: "{" }),
      entry({ name: "list", inputSchema: "[]" }),
      entry({ name: "noschema", inputSchema: null }),
      "not an object",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["search", "noschema"]);
    expect(tools[1]?.inputSchema).toBeNull();
    expect(skipped.map((s) => s.reason)).toEqual([
      "bad_name",
      "bad_name",
      "bad_name",
      "duplicate_name",
      "schema_too_large",
      "schema_not_json",
      "schema_not_object",
    ]);
    expect(skipped[1]?.name).toBe("(no name)");
    expect(skipped[0]?.name).toBe('"has space"');
  });

  it("shows at most maxTools and caps text, cleaning control characters", () => {
    const many = Array.from({ length: SITE_TOOL_LIMITS.maxTools + 3 }, (_, i) => entry({ name: `t${i}` }));
    const listing = sanitizeSiteTools(many, 99);
    expect(listing.tools).toHaveLength(SITE_TOOL_LIMITS.maxTools);
    expect(listing.skipped.filter((s) => s.reason === "too_many")).toHaveLength(3);
    expect(listing.total).toBe(99);
    const [tool] = sanitizeSiteTools([
      entry({ description: `line one\n\u0007line two ${"d".repeat(SITE_TOOL_LIMITS.maxDescriptionChars)}` }),
    ]).tools;
    expect(tool?.description.startsWith("line one line two")).toBe(true);
    expect(tool?.description.length).toBe(SITE_TOOL_LIMITS.maxDescriptionChars);
  });
});

describe("checkSiteToolArgs", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
      price: { type: "number" },
      sort: { type: "string", enum: ["asc", "desc"] },
      tags: { type: ["array", "null"] },
    },
    required: ["query"],
    additionalProperties: false,
  };

  it("passes matching arguments and anything for a tool without a schema", () => {
    expect(checkSiteToolArgs(schema, { query: "shoes", limit: 5, price: 3, sort: "asc", tags: null })).toEqual([]);
    expect(checkSiteToolArgs(null, { anything: 1 })).toEqual([]);
  });

  it("names a missing required key, a wrong type, a bad enum value and an unknown key", () => {
    expect(checkSiteToolArgs(schema, { limit: 1.5, sort: "up", extra: true })).toEqual([
      "missing required `query`",
      "`limit` should be integer, got number",
      "`sort` must be one of [\"asc\",\"desc\"]",
      "`extra` is not an argument of this tool",
    ]);
  });

  it("allows unknown keys unless the schema forbids them, and refuses a non-object schema", () => {
    expect(checkSiteToolArgs({ type: "object", properties: {} }, { extra: 1 })).toEqual([]);
    expect(checkSiteToolArgs({ type: "string" }, {})).toHaveLength(1);
  });
});
