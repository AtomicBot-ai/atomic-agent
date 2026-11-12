import { describe, expect, it } from "vitest";

import {
  findToolBehindSchemaError,
  isToolSchemaErrorText,
} from "./tool-schema-rejection.js";

const LM_STUDIO_500 =
  "openai provider 500: {\"error\":\"JSON schema error at #/$defs/RecordSource/oneOf/1/properties/evidence: schema must be an object\"}";

function tool(name: string, parameters: unknown): Record<string, unknown> {
  return { type: "function", function: { name, parameters } };
}

const plugin = tool("plugin__lookup", {
  type: "object",
  $defs: {
    RecordSource: {
      oneOf: [
        { type: "object" },
        { type: "object", properties: { evidence: true } },
      ],
    },
  },
});

const other = tool("os__fs__read", {
  type: "object",
  properties: { path: { type: "string" } },
});

describe("tool schema rejection (ATO-1399)", () => {
  it("recognises the llama.cpp / LM Studio wording", () => {
    expect(isToolSchemaErrorText(LM_STUDIO_500)).toBe(true);
    expect(isToolSchemaErrorText("openai provider 500: upstream died")).toBe(
      false,
    );
  });

  it("names the one tool whose schema holds a non-object at the pointer", () => {
    expect(
      findToolBehindSchemaError(LM_STUDIO_500, [other, plugin]),
    ).toEqual({
      index: 1,
      name: "plugin__lookup",
      pointer: "/$defs/RecordSource/oneOf/1/properties/evidence",
    });
  });

  it("matches on the pre-rewrite schema when the sent one is already an object", () => {
    const sent = tool("plugin__lookup", {
      type: "object",
      $defs: {
        RecordSource: {
          oneOf: [{ type: "object" }, { properties: { evidence: {} } }],
        },
      },
    });
    expect(
      findToolBehindSchemaError(LM_STUDIO_500, [other, sent], [other, plugin])
        ?.index,
    ).toBe(1);
  });

  it("reads a pointer into the request body", () => {
    const text = "JSON schema error at #/tools/0/function/parameters/properties/x: bad";
    expect(findToolBehindSchemaError(text, [other, plugin])?.name).toBe(
      "os__fs__read",
    );
  });

  it("names nothing when the pointer is ambiguous, missing or unmatched", () => {
    const twin = tool("plugin__twin", (plugin.function as any).parameters);
    expect(findToolBehindSchemaError(LM_STUDIO_500, [plugin, twin])).toBeNull();
    expect(
      findToolBehindSchemaError("JSON schema error: schema must be an object", [plugin]),
    ).toBeNull();
    expect(findToolBehindSchemaError(LM_STUDIO_500, [other])).toBeNull();
    expect(findToolBehindSchemaError("http 500", [plugin])).toBeNull();
  });

  it("never names reply or finish", () => {
    const reply = tool("reply", (plugin.function as any).parameters);
    expect(findToolBehindSchemaError(LM_STUDIO_500, [reply])).toBeNull();
  });
});
