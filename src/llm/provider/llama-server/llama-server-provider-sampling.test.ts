import { describe, expect, it, vi } from "vitest";

import type { LlamaServerClient } from "../../llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE, type ModelProfile } from "../../model-profile.js";
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
