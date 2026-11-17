import { describe, expect, it, vi } from "vitest";

import { AudioUnsupportedError } from "../llm-provider.js";
import { describeAudioViaOpenAi } from "./openai-describe-audio.js";
import type { OpenAiHttpDeps } from "./openai-http.js";
import { OpenAiProvider } from "./openai-provider.js";

function recordingFetch(): { fetchImpl: typeof fetch; body: () => Record<string, unknown>; calls: () => number } {
  let sent: Record<string, unknown> = {};
  let count = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    count += 1;
    sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi there" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, body: () => sent, calls: () => count };
}

const CLIP = {
  prompt: "Transcribe it",
  audio: { bytes: new Uint8Array([1, 2, 3]), format: "mp3" as const },
};

describe("describeAudioViaOpenAi (ATO-497)", () => {
  it("sends one user message: the input_audio part, then the prompt", async () => {
    const { fetchImpl, body } = recordingFetch();
    const deps: OpenAiHttpDeps = {
      baseUrl: "https://api.example.com",
      apiKey: "key",
      extraHeaders: {},
      requestTimeoutMs: 5_000,
      fetchImpl,
      label: "testprov",
    };
    const result = await describeAudioViaOpenAi(deps, "gpt-4o-audio-preview", CLIP);
    expect(result.text).toBe("hi there");
    expect(body().model).toBe("gpt-4o-audio-preview");
    expect(body().stream).toBe(false);
    expect(body().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: "AQID", format: "mp3" } },
          { type: "text", text: "Transcribe it" },
        ],
      },
    ]);
  });
});

describe("OpenAiProvider audio capability (ATO-497)", () => {
  const base = { id: "custom", baseUrl: "https://api.example.com", apiKey: "k", defaultChatModel: "m" };

  it("is off unless the factory says the model hears, and never calls the service then", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const provider = new OpenAiProvider({ ...base, fetchImpl });
    expect(provider.capabilities.audio).toBe(false);
    expect(provider.capabilities.audioSource).toBe("unknown");
    await expect(provider.describeAudio(CLIP)).rejects.toBeInstanceOf(AudioUnsupportedError);
    expect(calls()).toBe(0);
  });

  it("sends the clip when the config says the model takes audio", async () => {
    const { fetchImpl, body } = recordingFetch();
    const provider = new OpenAiProvider({
      ...base,
      fetchImpl,
      supportsAudio: true,
      audioSource: "config.userModels",
    });
    expect(provider.capabilities.audioSource).toBe("config.userModels");
    const result = await provider.describeAudio(CLIP);
    expect(result.text).toBe("hi there");
    expect(JSON.stringify(body().messages)).toContain('"input_audio"');
  });
});
