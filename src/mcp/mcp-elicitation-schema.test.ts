import { describe, expect, it } from "vitest";

import { validateElicitationAnswer } from "./mcp-elicitation-answer.js";
import {
  MAX_ELICITATION_FIELDS,
  parseElicitationSchema,
  type McpElicitationField,
} from "./mcp-elicitation-schema.js";

function fieldsOf(schema: unknown): McpElicitationField[] {
  const parsed = parseElicitationSchema(schema);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

const FORM = {
  type: "object",
  properties: {
    account: { type: "string", oneOf: [{ const: "a1", title: "Work" }, { const: "a2", title: "Home" }] },
    note: { type: "string", maxLength: 5 },
    email: { type: "string", format: "email" },
    count: { type: "integer", minimum: 1, maximum: 3 },
    sure: { type: "boolean", default: false },
    tags: { type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 2 },
  },
  required: ["account", "sure"],
};

describe("parseElicitationSchema", () => {
  it("turns a flat form into neutral fields", () => {
    const fields = fieldsOf(FORM);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["account", "enum", true],
      ["note", "string", false],
      ["email", "string", false],
      ["count", "number", false],
      ["sure", "boolean", true],
      ["tags", "multi_enum", false],
    ]);
    const account = fields[0];
    expect(account.kind === "enum" && account.options).toEqual([
      { value: "a1", label: "Work" },
      { value: "a2", label: "Home" },
    ]);
  });

  it("accepts an empty form as a plain confirmation", () => {
    expect(fieldsOf({ type: "object", properties: {} })).toEqual([]);
  });

  it("reads legacy enumNames as labels", () => {
    const [f] = fieldsOf({
      type: "object",
      properties: { p: { type: "string", enum: ["a", "b"], enumNames: ["A", "B"] } },
    });
    expect(f.kind === "enum" && f.options[1]).toEqual({ value: "b", label: "B" });
  });

  it.each([
    ["not an object schema", { type: "array" }],
    ["no properties", { type: "object" }],
    ["a nested object", { type: "object", properties: { o: { type: "object", properties: {} } } }],
    ["an array of free strings", { type: "object", properties: { a: { type: "array", items: { type: "string" } } } }],
    ["an unknown format", { type: "object", properties: { s: { type: "string", format: "password" } } }],
    ["an empty enum", { type: "object", properties: { s: { type: "string", enum: [] } } }],
    ["required naming a missing field", { type: "object", properties: {}, required: ["x"] }],
  ])("refuses %s", (_label, schema) => {
    expect(parseElicitationSchema(schema).ok).toBe(false);
  });

  it("refuses a form with too many fields", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_ELICITATION_FIELDS; i += 1) properties[`f${i}`] = { type: "boolean" };
    expect(parseElicitationSchema({ type: "object", properties }).ok).toBe(false);
  });

  it("flags credential-looking fields as sensitive", () => {
    const fields = fieldsOf({
      type: "object",
      properties: {
        api_key: { type: "string" },
        code: { type: "string", title: "One-time PIN" },
        city: { type: "string" },
      },
    });
    expect(fields.map((f) => f.sensitive)).toEqual([true, true, false]);
  });
});

describe("validateElicitationAnswer", () => {
  const fields = fieldsOf(FORM);

  it("passes a valid answer through", () => {
    const res = validateElicitationAnswer(fields, {
      account: "a2",
      sure: true,
      count: 2,
      email: "a@b.io",
      tags: ["x"],
    });
    expect(res).toEqual({
      ok: true,
      value: { account: "a2", sure: true, count: 2, email: "a@b.io", tags: ["x"] },
    });
  });

  it.each([
    ["a missing required field", { account: "a1" }],
    ["an unknown field", { account: "a1", sure: true, extra: 1 }],
    ["a value outside the enum", { account: "zz", sure: true }],
    ["a too long string", { account: "a1", sure: true, note: "123456" }],
    ["a bad email", { account: "a1", sure: true, email: "nope" }],
    ["a non-integer", { account: "a1", sure: true, count: 1.5 }],
    ["a number out of range", { account: "a1", sure: true, count: 9 }],
    ["a wrong type", { account: "a1", sure: "yes" }],
    ["too many selected", { account: "a1", sure: true, tags: ["x", "y", "x"] }],
    ["not an object", "a1"],
  ])("refuses %s", (_label, content) => {
    expect(validateElicitationAnswer(fields, content).ok).toBe(false);
  });

  it("never puts the value into the reason", () => {
    const secretFields = fieldsOf({
      type: "object",
      properties: { token: { type: "string", maxLength: 3 } },
    });
    const res = validateElicitationAnswer(secretFields, { token: "hunter2-secret" });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });
});
