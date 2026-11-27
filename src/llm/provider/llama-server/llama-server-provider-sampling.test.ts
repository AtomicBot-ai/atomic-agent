import { describe, expect, it, vi } from "vitest";

import type { LlamaServerClient } from "../../llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE, type ModelProfile } from "../../model-profile.js";
import type { CompletionRequest, CompletionResult } from "../completion-types.js";
import { LlamaServerProvider } from "./llama-server-provider.js";

const SAMPLING = { temperature: 0.6, topK: 20, minP: 0 };

function providerFor(profile: ModelProfile) {
  const sent: CompletionRequest[] = [];
  const complete = vi.fn(async (request: CompletionRequest) => {
    sent.push(request);
    return { text: "x" } as unknown as CompletionResult;
  });
  const client = { complete } as unknown as LlamaServerClient;
  const provider = new LlamaServerProvider(client, {
    getProfile: () => profile,
    visionEnabledByConfig: false,
    visionAutoDetect: false,
    maxImageBytes: 1024,
    maxImagesPerCall: 1,
    requestTimeoutMs: 30_000,
  });
  return { provider, sent };
}

describe("LlamaServerProvider model sampling (ATO-2202)", () => {
  it("hands the client the profile's recommended sampling", async () => {
    const { provider, sent } = providerFor({ ...PLAIN_INSTRUCT_PROFILE, sampling: SAMPLING });
    await provider.complete({ prompt: "p" });
    expect(sent[0]?.modelSampling).toEqual(SAMPLING);
  });

  it("adds nothing when the model named no sampling", async () => {
    const { provider, sent } = providerFor(PLAIN_INSTRUCT_PROFILE);
    await provider.complete({ prompt: "p" });
    expect(sent[0]).not.toHaveProperty("modelSampling");
  });

  it("keeps a modelSampling the caller already set", async () => {
    const { provider, sent } = providerFor({ ...PLAIN_INSTRUCT_PROFILE, sampling: SAMPLING });
    await provider.complete({ prompt: "p", modelSampling: { temperature: 1 } });
    expect(sent[0]?.modelSampling).toEqual({ temperature: 1 });
  });
});

describe("LlamaServerProvider per-model sampling (ATO-2482)", () => {
  it("matches the served file to the catalog and picks the thinking-off set", async () => {
    const { provider, sent } = providerFor({
      ...QWEN_THINK_PROFILE,
      modelPath: "/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
    });
    await provider.complete({ prompt: "p", disableThinking: true });
    expect(sent[0]?.modelSampling).toMatchObject({ temperature: 0.7, topP: 0.8, topK: 20 });
    await provider.complete({ prompt: "p" });
    expect(sent[1]?.modelSampling).toMatchObject({ temperature: 1, topP: 0.95, topK: 20 });
  });
});
