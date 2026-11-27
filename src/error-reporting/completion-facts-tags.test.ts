import { describe, expect, it } from "vitest";
import { completionFactsTags } from "./completion-facts-tags.js";
import { sanitizeLlmFailureTags } from "./llm-failure-tags.js";

const facts = {
  finishReason: "stop",
  reasoningPresent: false,
  promptTokens: 4096,
  completionTokens: 1,
};

/** ATO-2421: the shape of a failed completion and its server, as fixed words and counts. */
describe("completionFactsTags", () => {
  it("sends the finish reason, the reasoning flag, the server's counts and the server kind", () => {
    expect(completionFactsTags(facts, "ollama")).toEqual({
      finish_reason: "stop",
      reasoning_present: "no",
      served_prompt_tokens: "4096",
      served_reply_tokens: "1",
      server_kind: "ollama",
    });
  });

  it("reads llama-server's stop_type when no finish reason came", () => {
    const tags = completionFactsTags({ ...facts, finishReason: null, stopType: "eos" }, "llama_server");
    expect(tags.finish_reason).toBe("eos");
  });

  it("says none when the server sent no reason at all", () => {
    expect(completionFactsTags({ ...facts, finishReason: null }, undefined).finish_reason).toBe("none");
  });

  it("never sends a finish reason or a server kind that is not on its list", () => {
    const tags = completionFactsTags({ ...facts, finishReason: "/Users/me/secret prompt" }, "my-box.local");
    expect(tags.finish_reason).toBe("other");
    expect(tags.server_kind).toBe("other");
    expect(JSON.stringify(tags)).not.toContain("secret");
    expect(JSON.stringify(tags)).not.toContain("my-box");
  });

  it("reads zero counts as unreported", () => {
    const tags = completionFactsTags({ ...facts, promptTokens: 0, completionTokens: Number.NaN }, undefined);
    expect(tags.served_prompt_tokens).toBe("unknown");
    expect(tags.served_reply_tokens).toBe("unknown");
  });

  it("adds nothing without facts or a server kind", () => {
    expect(completionFactsTags(undefined, undefined)).toEqual({});
  });
});

describe("sanitizeLlmFailureTags: completion facts (ATO-2421)", () => {
  it("adds the facts beside the provider tags", () => {
    expect(
      sanitizeLlmFailureTags({
        providerId: "ollama",
        completionFacts: { ...facts, reasoningPresent: true },
        serverKind: "ollama",
      }),
    ).toEqual({
      provider_id: "ollama",
      finish_reason: "stop",
      reasoning_present: "yes",
      served_prompt_tokens: "4096",
      served_reply_tokens: "1",
      server_kind: "ollama",
    });
  });
});
