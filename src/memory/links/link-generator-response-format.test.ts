import { describe, expect, it } from "vitest";

import { parseLinkGeneratorOutput } from "./link-generator-parser.js";
import { LINK_GENERATOR_RESPONSE_FORMAT } from "./link-generator-response-format.js";

const allowlist = new Set([1, 2]);

describe("LINK_GENERATOR_RESPONSE_FORMAT under strict mode", () => {
  it("requires every top-level key, so OpenAI accepts the schema", () => {
    // With `links` optional OpenAI refused every call: "'required' is
    // required to be supplied and to be an array including every key
    // in properties. Missing 'links'."
    const { schema } = LINK_GENERATOR_RESPONSE_FORMAT;
    expect(schema.required).toEqual(
      Object.keys(schema.properties as Record<string, unknown>),
    );
  });

  it("parses the strict abstain shape as none", () => {
    expect(
      parseLinkGeneratorOutput(JSON.stringify({ kind: "none", links: [] }), {
        allowlist,
      }),
    ).toEqual({ kind: "none" });
  });

  it("parses kind=links with an empty array as none", () => {
    expect(
      parseLinkGeneratorOutput(JSON.stringify({ kind: "links", links: [] }), {
        allowlist,
      }),
    ).toEqual({ kind: "none" });
  });

  it("ignores stray triples under kind=none", () => {
    const raw = JSON.stringify({
      kind: "none",
      links: [{ from_id: 1, to_id: 2, link_kind: "RELATES_TO" }],
    });
    expect(parseLinkGeneratorOutput(raw, { allowlist })).toEqual({
      kind: "none",
    });
  });
});
