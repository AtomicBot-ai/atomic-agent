import { describe, expect, it } from "vitest";

import { findStrictSchemaViolations } from "./find-strict-schema-violations.js";

const closedLeaf = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "integer", minimum: 1 } },
  required: ["id"],
};

describe("findStrictSchemaViolations", () => {
  it("accepts a closed object that requires every key, bounds included", () => {
    expect(
      findStrictSchemaViolations({
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["none", "links"] },
          links: { type: "array", maxItems: 16, items: closedLeaf },
          extra: { anyOf: [{ type: "null" }, closedLeaf] },
        },
        required: ["kind", "links", "extra"],
      }),
    ).toEqual([]);
  });

  it("flags an optional top-level key — the shape OpenAI answered 400 to", () => {
    expect(
      findStrictSchemaViolations({
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          links: { type: "array", items: closedLeaf },
        },
        required: ["kind"],
      }),
    ).toEqual(["(root): required is missing 'links'"]);
  });

  it("flags an optional key on an object nested in array items", () => {
    expect(
      findStrictSchemaViolations({
        type: "object",
        additionalProperties: false,
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { a: { type: "string" }, b: { type: "string" } },
              required: ["a"],
            },
          },
        },
        required: ["steps"],
      }),
    ).toEqual(["(root).steps[]: required is missing 'b'"]);
  });

  it("flags an open object inside an anyOf branch", () => {
    expect(
      findStrictSchemaViolations({
        type: "object",
        additionalProperties: false,
        properties: {
          procedure: {
            anyOf: [
              { type: "null" },
              { type: "object", properties: {}, required: [] },
            ],
          },
        },
        required: ["procedure"],
      }),
    ).toEqual([
      "(root).procedure.anyOf[1]: additionalProperties must be false",
    ]);
  });

  it("flags a required entry that names no property", () => {
    expect(
      findStrictSchemaViolations({
        ...closedLeaf,
        required: ["id", "ghost"],
      }),
    ).toEqual(["(root): required names unknown key 'ghost'"]);
  });

  it("refuses a root that is not an object schema", () => {
    expect(findStrictSchemaViolations({ type: "string" })).toEqual([
      "(root): must be an object schema",
    ]);
    expect(findStrictSchemaViolations(null)).toEqual([
      "(root): must be an object schema",
    ]);
  });
});
