import { describe, expect, it } from "vitest";

import { isCloudLink } from "./cloud-link.js";

const llm = {
  activeTextProvider: "openrouter",
  providers: [
    { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
    { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
    { id: "codex", kind: "subscription-cli" },
  ],
} as unknown as Parameters<typeof isCloudLink>[1];

describe("isCloudLink (ATO-1578)", () => {
  it("reads a remote API and a subscription CLI as cloud", () => {
    expect(isCloudLink("openrouter", llm)).toBe(true);
    expect(isCloudLink("codex", llm)).toBe(true);
  });

  it("reads llama-server and a server on this machine as local", () => {
    expect(isCloudLink("local-llama", llm)).toBe(false);
    expect(isCloudLink("lmstudio", llm)).toBe(false);
  });

  it("uses the active text provider when no link is named", () => {
    expect(isCloudLink(undefined, llm)).toBe(true);
    expect(isCloudLink(undefined, { ...llm, activeTextProvider: "local-llama" })).toBe(false);
  });

  it("keeps an unknown link off the cloud", () => {
    expect(isCloudLink("nope", llm)).toBe(false);
  });
});
