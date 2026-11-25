import { describe, expect, it } from "vitest";

import { encodeSyntheticGguf, qwen35Pairs } from "./gguf-metadata.fixtures.js";
import { parseGgufHeader } from "./gguf-metadata.js";
import { hasInlineMtpHead, mtpDraftLayers } from "./gguf-speculative.js";

describe("MTP head detection (ATO-452)", () => {
  it("reads <arch>.nextn_predict_layers from a real header", () => {
    const meta = parseGgufHeader(
      encodeSyntheticGguf({ ...qwen35Pairs(), "qwen35.nextn_predict_layers": 1 }),
    );
    expect(mtpDraftLayers(meta)).toBe(1);
    expect(hasInlineMtpHead(meta)).toBe(true);
  });

  it("says no for a header without the key", () => {
    const meta = parseGgufHeader(encodeSyntheticGguf(qwen35Pairs()));
    expect(mtpDraftLayers(meta)).toBe(0);
    expect(hasInlineMtpHead(meta)).toBe(false);
  });

  it("ignores another architecture's key, zero, negatives and junk", () => {
    expect(mtpDraftLayers({ architecture: "qwen35", keys: { "glm4moe.nextn_predict_layers": 1 } })).toBe(0);
    expect(mtpDraftLayers({ architecture: "qwen35", keys: { "qwen35.nextn_predict_layers": 0 } })).toBe(0);
    expect(mtpDraftLayers({ architecture: "qwen35", keys: { "qwen35.nextn_predict_layers": -2 } })).toBe(0);
    expect(mtpDraftLayers({ architecture: "qwen35", keys: { "qwen35.nextn_predict_layers": "1" } })).toBe(0);
    expect(mtpDraftLayers({ architecture: "qwen35", keys: { "qwen35.nextn_predict_layers": 1.5 } })).toBe(0);
    expect(mtpDraftLayers({ architecture: "", keys: { ".nextn_predict_layers": 1 } })).toBe(0);
  });
});
