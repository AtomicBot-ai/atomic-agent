import { describe, expect, it } from "vitest";

import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { perTurnModelRefusal } from "./per-turn-model.js";

const resolved: ResolvedLlmConfig = {
  activeTextProvider: "cloud",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "cloud", kind: "openrouter", defaultChatModel: "model-a" },
    { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", defaultChatModel: "qwen-default" },
  ],
};

describe("perTurnModelRefusal", () => {
  it("takes a cloud provider's other model (ATO-1148)", () => {
    expect(perTurnModelRefusal(resolved, "cloud", "model-b")).toBeNull();
  });

  it("refuses a local server for a project's model, which every project shares (ATO-1148)", () => {
    expect(perTurnModelRefusal(resolved, "lmstudio", "qwen-other")).toMatch(/local model/);
    expect(perTurnModelRefusal(resolved, "local-llama", "x")).toMatch(/local model/);
  });

  it("lets a Fusion turn ask LM Studio / Ollama for its role's model, never llama-server (ATO-1560)", () => {
    expect(perTurnModelRefusal(resolved, "lmstudio", "qwen-other", { localServer: "allow" })).toBeNull();
    expect(perTurnModelRefusal(resolved, "local-llama", "x", { localServer: "allow" })).toMatch(/local model/);
  });

  it("refuses an empty model and an unknown provider whatever the turn", () => {
    expect(perTurnModelRefusal(resolved, "cloud", "  ", { localServer: "allow" })).toMatch(/model id/);
    expect(perTurnModelRefusal(resolved, "nope", "x", { localServer: "allow" })).toMatch(/not configured/);
  });
});
