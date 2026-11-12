import { describe, expect, it } from "vitest";

import { toGeminiToolSchema, toGeminiTools } from "./gemini-tool-schema.js";

/** What an MCP server built on the official TypeScript SDK sends. */
const MCP_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", format: "uri", description: "Page to open" },
    when: { type: "string", format: "date-time" },
    mode: { type: "string", enum: ["fast", "full"], default: "fast" },
    kind: { const: "page" },
    retries: { type: "integer", minimum: 0, exclusiveMaximum: 10, multipleOf: 1 },
    tags: { type: "array", items: { type: "string" }, uniqueItems: true, minItems: 1 },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      properties: { $schema: { type: "string", description: "a property named $schema" } },
    },
    target: { oneOf: [{ type: "string" }, { type: "object", additionalProperties: false, properties: { id: { type: "string" } } }] },
  },
  required: ["url"],
};

describe("toGeminiToolSchema (ATO-1282)", () => {
  it("drops the keywords Gemini's schema has no field for, at every depth", () => {
    expect(toGeminiToolSchema(MCP_SCHEMA)).toEqual({
      type: "object",
      properties: {
        url: { type: "string", description: "Page to open" },
        when: { type: "string", format: "date-time" },
        mode: { type: "string", enum: ["fast", "full"], default: "fast" },
        kind: { enum: ["page"] },
        retries: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
        headers: {
          type: "object",
          properties: { $schema: { type: "string", description: "a property named $schema" } },
        },
        target: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" } } }] },
      },
      required: ["url"],
    });
  });

  it("keeps a schema that needs nothing as the same object", () => {
    const clean = { type: "object", properties: { q: { type: "string", enum: ["a"] } }, required: ["q"] };
    expect(toGeminiToolSchema(clean)).toBe(clean);
  });

  it("leaves $ref, $defs, allOf and not as they are, cleaning inside them", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } } },
      allOf: [{ required: ["a"] }],
      not: { type: "null" },
    };
    expect(toGeminiToolSchema(schema)).toEqual({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "object", properties: { x: { type: "string" } } } },
      allOf: [{ required: ["a"] }],
      not: { type: "null" },
    });
  });

  it("does not merge oneOf into an anyOf that is already there", () => {
    const schema = { anyOf: [{ type: "string" }], oneOf: [{ type: "number" }] };
    expect(toGeminiToolSchema(schema)).toBe(schema);
  });

  it("does not mutate the caller's schema", () => {
    const copy = structuredClone(MCP_SCHEMA);
    toGeminiToolSchema(MCP_SCHEMA);
    expect(MCP_SCHEMA).toEqual(copy);
  });
});

describe("toGeminiTools (ATO-1282)", () => {
  it("cleans each function's parameters and keeps the rest of the tool", () => {
    const clean = { type: "function", function: { name: "ok", parameters: { type: "object", properties: {} } } };
    const dirty = { type: "function", function: { name: "mcp__web__open", description: "d", parameters: MCP_SCHEMA } };
    const out = toGeminiTools([clean, dirty]) as Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
    expect(out[0]).toBe(clean);
    expect(out[1]!.function.name).toBe("mcp__web__open");
    expect(out[1]!.function.description).toBe("d");
    expect(out[1]!.function.parameters).not.toHaveProperty("$schema");
    expect(out[1]!.function.parameters).not.toHaveProperty("additionalProperties");
  });

  it("returns the same array when no tool changed", () => {
    const tools = [{ type: "function", function: { name: "ok", parameters: { type: "object" } } }];
    expect(toGeminiTools(tools)).toBe(tools);
  });
});
