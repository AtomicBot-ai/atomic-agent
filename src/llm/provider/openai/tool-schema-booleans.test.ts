import { describe, expect, it } from "vitest";

import { buildOpenAiChatBody } from "./openai-build-body.js";
import {
  normalizeSchemaBooleans,
  normalizeToolSchemaBooleans,
} from "./tool-schema-booleans.js";

/** The schema shape from the ATO-1399 report, trimmed to what matters. */
function reportedSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { source: { $ref: "#/$defs/RecordSource" } },
    required: ["source"],
    $defs: {
      RecordSource: {
        oneOf: [
          { type: "object", properties: { url: { type: "string" } } },
          {
            type: "object",
            properties: { kind: { type: "string" }, evidence: true },
            required: ["kind", "evidence"],
          },
        ],
      },
    },
  };
}

describe("normalizeSchemaBooleans (ATO-1399)", () => {
  it("rewrites $defs/RecordSource/oneOf/1/properties/evidence: true to {}", () => {
    const input = reportedSchema();
    const snapshot = structuredClone(input);
    const out = normalizeSchemaBooleans(input) as any;

    expect(out.$defs.RecordSource.oneOf[1].properties.evidence).toEqual({});
    expect(out.$defs.RecordSource.oneOf[1].required).toEqual([
      "kind",
      "evidence",
    ]);
    // Untouched branches keep their identity; the input is not mutated.
    expect(out.$defs.RecordSource.oneOf[0]).toBe(
      (input as any).$defs.RecordSource.oneOf[0],
    );
    expect(input).toEqual(snapshot);
  });

  it("returns the same reference when there is nothing to rewrite", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    };
    expect(normalizeSchemaBooleans(schema)).toBe(schema);
  });

  it("drops a false property and its required entry", () => {
    const out = normalizeSchemaBooleans({
      type: "object",
      properties: { a: { type: "string" }, b: false },
      required: ["a", "b"],
    });
    expect(out).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("keeps boolean additionalProperties and recurses an object one", () => {
    const out = normalizeSchemaBooleans({
      type: "object",
      properties: {
        open: { type: "object", additionalProperties: true },
        map: { type: "object", additionalProperties: { anyOf: [true] } },
      },
      additionalProperties: false,
    }) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.open.additionalProperties).toBe(true);
    expect(out.properties.map.additionalProperties).toEqual({ anyOf: [{}] });
  });

  it("covers items, prefixItems, compositions, not and conditionals", () => {
    const out = normalizeSchemaBooleans({
      type: "object",
      properties: {
        anything: { type: "array", items: true },
        empty: { type: "array", items: false },
        tuple: { type: "array", prefixItems: [true, { type: "string" }] },
        legacyTuple: { type: "array", items: [false] },
        either: { anyOf: [false, { type: "string" }] },
        never: { oneOf: [false] },
        both: { allOf: [true, { type: "string" }] },
        notFalse: { type: "string", not: false },
        notTrue: { not: true },
        cond: { if: true, then: false, else: { type: "string" } },
      },
      patternProperties: { "^x-": false, "^y-": true },
      dependentSchemas: { a: true, b: false, c: { required: ["a"] } },
      definitions: { Never: false, Any: true },
    }) as any;
    const p = out.properties;
    expect(p.anything).toEqual({ type: "array" });
    expect(p.empty).toEqual({ type: "array", maxItems: 0 });
    expect(p.tuple.prefixItems).toEqual([{}, { type: "string" }]);
    expect(p.legacyTuple.items).toEqual([{ not: {} }]);
    expect(p.either.anyOf).toEqual([{ type: "string" }]);
    expect(p.never.oneOf).toEqual([{ not: {} }]);
    expect(p.both.allOf).toEqual([{ type: "string" }]);
    expect(p.notFalse).toEqual({ type: "string" });
    expect(p.notTrue).toEqual({ not: {} });
    expect(p.cond).toEqual({ if: {}, then: { not: {} }, else: { type: "string" } });
    expect(out.patternProperties).toEqual({ "^y-": {} });
    expect(out.dependentSchemas).toEqual({ c: { required: ["a"] } });
    expect(out.definitions).toEqual({ Never: { not: {} }, Any: {} });
  });

  it("caps items: false at the prefixItems length, not at zero", () => {
    const tuple = { type: "string" };
    expect(
      normalizeSchemaBooleans({
        type: "array",
        prefixItems: [tuple, tuple],
        items: false,
        minItems: 2,
      }),
    ).toEqual({
      type: "array",
      prefixItems: [tuple, tuple],
      minItems: 2,
      maxItems: 2,
    });
    expect(
      normalizeSchemaBooleans({
        type: "array",
        prefixItems: [tuple, tuple],
        items: false,
        maxItems: 1,
      }),
    ).toMatchObject({ maxItems: 1 });
  });

  it("turns a boolean root into an object schema", () => {
    expect(normalizeSchemaBooleans(true)).toEqual({ type: "object" });
  });
});

describe("normalizeToolSchemaBooleans", () => {
  it("rewrites only the tool that needs it and keeps the array otherwise", () => {
    const clean = {
      type: "function",
      function: { name: "clean", parameters: { type: "object" } },
    };
    const bad = {
      type: "function",
      function: { name: "plugin__lookup", parameters: reportedSchema() },
    };
    expect(normalizeToolSchemaBooleans([clean])).toEqual([clean]);
    const same = [clean];
    expect(normalizeToolSchemaBooleans(same)).toBe(same);

    const out = normalizeToolSchemaBooleans([clean, bad]);
    expect(out[0]).toBe(clean);
    expect(out[1]).not.toBe(bad);
    expect(
      (out[1] as any).function.parameters.$defs.RecordSource.oneOf[1]
        .properties.evidence,
    ).toEqual({});
  });

  it("is applied to the tools of every chat body", () => {
    const body = buildOpenAiChatBody(
      {
        prompt: "hi",
        tools: [
          {
            type: "function",
            function: { name: "plugin__lookup", parameters: reportedSchema() },
          },
        ],
      },
      "local-model",
      false,
    );
    const tools = body.tools as any[];
    expect(
      tools[0].function.parameters.$defs.RecordSource.oneOf[1].properties
        .evidence,
    ).toEqual({});
  });
});
