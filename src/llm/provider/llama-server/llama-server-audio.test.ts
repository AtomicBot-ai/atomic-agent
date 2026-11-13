import { describe, expect, it, vi } from "vitest";

import type { LlamaServerClient } from "../../llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE, type ModelProfile } from "../../model-profile.js";
import { AudioUnsupportedError } from "../llm-provider.js";
import { resolveAudioCapabilities } from "./llama-server-audio.js";
import { LlamaServerProvider } from "./llama-server-provider.js";

const HEARS: ModelProfile = {
  ...PLAIN_INSTRUCT_PROFILE,
  vision: { supported: false, source: "absent" },
  audio: { supported: true, source: "modalities.audio" },
};

const DEAF: ModelProfile = {
  ...PLAIN_INSTRUCT_PROFILE,
  vision: { supported: true, source: "has_multimodal" },
};

function provider(profile: ModelProfile, fetchImpl: typeof fetch): LlamaServerProvider {
  return new LlamaServerProvider({} as unknown as LlamaServerClient, {
    getProfile: () => profile,
    visionEnabledByConfig: true,
    visionAutoDetect: true,
    maxImageBytes: 1024,
    maxImagesPerCall: 2,
    requestTimeoutMs: 30_000,
    baseUrlOverride: "http://test-llama:9999",
    fetchImpl,
  });
}

function okFetch(content: string) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("llama-server audio input (ATO-497)", () => {
  it("reads the capability from the profile's /props audio flag only", () => {
    expect(resolveAudioCapabilities(HEARS)).toEqual({
      audio: true,
      audioSource: "modalities.audio",
    });
    // A vision projector is not an audio one.
    expect(resolveAudioCapabilities(DEAF)).toEqual({
      audio: false,
      audioSource: "absent",
    });
    expect(provider(HEARS, okFetch("")).capabilities.audio).toBe(true);
    expect(provider(DEAF, okFetch("")).capabilities.audio).toBe(false);
  });

  it("sends the clip as an input_audio part with its format, then the prompt", async () => {
    const fetchImpl = okFetch("hello world");
    const result = await provider(HEARS, fetchImpl as unknown as typeof fetch).describeAudio({
      prompt: "Transcribe it",
      audio: { bytes: new Uint8Array([1, 2, 3]), format: "wav" },
    });
    expect(result.text).toBe("hello world");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test-llama:9999/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: unknown[] }>;
    };
    expect(body.messages[0]!.content).toEqual([
      { type: "input_audio", input_audio: { data: "AQID", format: "wav" } },
      { type: "text", text: "Transcribe it" },
    ]);
  });

  it("refuses up front when the loaded model takes no audio", async () => {
    const fetchImpl = okFetch("x");
    await expect(
      provider(DEAF, fetchImpl as unknown as typeof fetch).describeAudio({
        prompt: "x",
        audio: { bytes: new Uint8Array([1]), format: "mp3" },
      }),
    ).rejects.toBeInstanceOf(AudioUnsupportedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the audio call in a server error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(
      provider(HEARS, fetchImpl as unknown as typeof fetch).describeAudio({
        prompt: "x",
        audio: { bytes: new Uint8Array([1]), format: "mp3" },
      }),
    ).rejects.toThrow(/^audio request returned http 500/);
  });
});
