import { describe, expect, it } from "vitest";
import { isGrammarRefusal } from "./grammar-refusal.js";

describe("isGrammarRefusal (ATO-1675)", () => {
  it("reads llama.cpp's grammar parse failure as a refusal", () => {
    expect(isGrammarRefusal(400, "llama-server returned http 400: Failed to parse grammar", "invalid_request_error")).toBe(true);
    expect(
      isGrammarRefusal(400, "llama-server reported an error mid-stream (http 400): Failed to parse grammar"),
    ).toBe(true);
  });

  it("reads a validating server that names the field as a refusal", () => {
    expect(isGrammarRefusal(400, "llama-server returned http 400: grammar: Extra inputs are not permitted")).toBe(true);
  });

  it("is false for any other status, a 400 that names no grammar, and a context overflow", () => {
    expect(isGrammarRefusal(500, "Failed to parse grammar")).toBe(false);
    expect(isGrammarRefusal(null, "Failed to parse grammar")).toBe(false);
    expect(isGrammarRefusal(400, "llama-server returned http 400")).toBe(false);
    expect(isGrammarRefusal(400, "the request exceeds the available context size", "invalid_request_error")).toBe(false);
    expect(isGrammarRefusal(400, "grammar-sized prompt too long", "exceed_context_size_error")).toBe(false);
  });
});
