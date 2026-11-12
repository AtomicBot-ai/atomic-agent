import { describe, expect, it } from "vitest";
import { gbnfAccepts } from "./gbnf-test-helpers.js";
import { JsonSchemaGbnfError, jsonSchemaToGbnf } from "./json-schema-gbnf.js";

/** The grammar `browser.extract` hands a local model for a caller's schema (ATO-699). */

const accepts = (schema: Record<string, unknown>, text: string): boolean =>
  gbnfAccepts(jsonSchemaToGbnf(schema), "root", text);

describe("jsonSchemaToGbnf", () => {
  const plans = {
    type: "object",
    properties: {
      plans: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
            tier: { enum: ["basic", "pro"] },
            note: { type: ["string", "null"] },
          },
          required: ["name", "price"],
        },
      },
    },
    required: ["plans"],
  };

  it("admits objects of the schema's shape, with optional keys left out or present", () => {
    expect(accepts(plans, '{"plans":[{"name":"Pro","price":9.5}]}')).toBe(true);
    expect(accepts(plans, '{"plans": [ {"name":"Pro","price":9,"tier":"pro","note":null}, {"name":"x","price":-1,"note":"hi"} ]}')).toBe(true);
    expect(accepts(plans, '{"plans":[]}')).toBe(true);
  });

  it("refuses a missing required key, an unknown key, a wrong type and anything around the JSON", () => {
    expect(accepts(plans, '{"plans":[{"price":9}]}')).toBe(false);
    expect(accepts(plans, '{"plans":[{"name":"Pro","price":9,"extra":1}]}')).toBe(false);
    expect(accepts(plans, '{"plans":[{"name":"Pro","price":"9"}]}')).toBe(false);
    expect(accepts(plans, '{"plans":[{"name":"Pro","price":9,"tier":"gold"}]}')).toBe(false);
    expect(accepts(plans, "{}")).toBe(false);
    expect(accepts(plans, 'Here: {"plans":[]}')).toBe(false);
  });

  it("lets any subset of all-optional keys appear, in declared order", () => {
    const schema = { type: "object", properties: { a: { type: "integer" }, b: { type: "boolean" }, c: { const: 3 } } };
    expect(accepts(schema, "{}")).toBe(true);
    expect(accepts(schema, '{"b":true}')).toBe(true);
    expect(accepts(schema, '{"a":1,"c":3}')).toBe(true);
    expect(accepts(schema, '{"c":3,"a":1}')).toBe(false);
    expect(accepts(schema, '{"a":1.5}')).toBe(false);
    expect(accepts(schema, '{"c":4}')).toBe(false);
  });

  it("shapes arrays, minItems, anyOf and short string lengths", () => {
    expect(accepts({ type: "array", items: { type: "string" }, minItems: 1 }, "[]")).toBe(false);
    expect(accepts({ type: "array", items: { type: "string" }, minItems: 1 }, '["a"]')).toBe(true);
    const either = { anyOf: [{ type: "integer" }, { type: "string", maxLength: 2 }] };
    expect(accepts(either, "12")).toBe(true);
    expect(accepts(either, '"ab"')).toBe(true);
    expect(accepts(either, '"abc"')).toBe(false);
    expect(accepts({ type: "string", minLength: 1 }, '""')).toBe(false);
  });

  it("falls back to any JSON for parts it does not shape", () => {
    expect(accepts({}, '{"anything":[1,true,null]}')).toBe(true);
    expect(accepts({ type: "object" }, '{"k":"v"}')).toBe(true);
    expect(accepts({ type: "object", properties: { x: {} }, required: ["x"] }, '{"x":[{"deep":1}]}')).toBe(true);
  });

  it("quotes enum and key literals that carry quotes, backslashes and non-ASCII text", () => {
    const schema = { type: "object", properties: { 'say "hi"': { enum: ["a\\b", "Цена"] } }, required: ['say "hi"'] };
    expect(accepts(schema, '{"say \\"hi\\"":"a\\\\b"}')).toBe(true);
    expect(accepts(schema, '{"say \\"hi\\"":"Цена"}')).toBe(true);
  });

  it("refuses an empty enum and a schema too large for a grammar", () => {
    expect(() => jsonSchemaToGbnf({ enum: [] })).toThrow(JsonSchemaGbnfError);
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, { type: "string" }])) };
    expect(() => jsonSchemaToGbnf(wide, { maxRules: 20 })).toThrow(JsonSchemaGbnfError);
  });
});
