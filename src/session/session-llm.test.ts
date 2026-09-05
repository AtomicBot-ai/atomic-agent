import { describe, expect, it } from "vitest";
import { readSessionLlmStamp, SESSION_LLM_METADATA_KEY } from "./session-llm.js";

describe("readSessionLlmStamp", () => {
  it("reads a well-formed stamp", () => {
    expect(
      readSessionLlmStamp({
        [SESSION_LLM_METADATA_KEY]: {
          providerId: "openrouter",
          chatModel: "z-ai/glm-5.2",
        },
      }),
    ).toEqual({ providerId: "openrouter", chatModel: "z-ai/glm-5.2" });
  });

  it("normalises a missing or empty model to null", () => {
    expect(
      readSessionLlmStamp({
        [SESSION_LLM_METADATA_KEY]: { providerId: "local-llama" },
      }),
    ).toEqual({ providerId: "local-llama", chatModel: null });
    expect(
      readSessionLlmStamp({
        [SESSION_LLM_METADATA_KEY]: { providerId: "local-llama", chatModel: "" },
      }),
    ).toEqual({ providerId: "local-llama", chatModel: null });
  });

  it("degrades malformed values to no stamp instead of crashing", () => {
    // Metadata is a free-form JSON bag: old sessions, other writers and
    // hand-edited stores all feed into it.
    expect(readSessionLlmStamp(undefined)).toBeNull();
    expect(readSessionLlmStamp({})).toBeNull();
    expect(readSessionLlmStamp({ [SESSION_LLM_METADATA_KEY]: null })).toBeNull();
    expect(readSessionLlmStamp({ [SESSION_LLM_METADATA_KEY]: "gpt" })).toBeNull();
    expect(readSessionLlmStamp({ [SESSION_LLM_METADATA_KEY]: [] })).toBeNull();
    expect(
      readSessionLlmStamp({ [SESSION_LLM_METADATA_KEY]: { providerId: "" } }),
    ).toBeNull();
    expect(
      readSessionLlmStamp({ [SESSION_LLM_METADATA_KEY]: { providerId: 7 } }),
    ).toBeNull();
  });
});
