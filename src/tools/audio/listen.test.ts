import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AudioUnsupportedError,
  type AudioRequest,
  type LlmProvider,
  type VisionResult,
} from "../../llm/index.js";
import { buildAudioListenTool, DEFAULT_AUDIO_PROMPT } from "./listen.js";
import { registerAudioTools } from "./index.js";

const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);

function fakeProvider(options: {
  audio: boolean;
  onCall?: (request: AudioRequest) => Promise<VisionResult>;
  withMethod?: boolean;
}): LlmProvider & { describeAudio: ReturnType<typeof vi.fn> } {
  const describeAudio = vi.fn(
    options.onCall ?? (async () => ({ text: "hello from the clip", durationMs: 5 })),
  );
  return {
    id: "local-llama",
    name: "llama.cpp",
    chatModelId: "gemma-3n",
    capabilities: { vision: false, visionSource: "absent", audio: options.audio, audioSource: options.audio ? "modalities.audio" : "absent" },
    ...(options.withMethod === false ? {} : { describeAudio }),
  } as unknown as LlmProvider & { describeAudio: ReturnType<typeof vi.fn> };
}

const ctx = (workingDir: string, providerId?: string) => ({
  workingDir,
  sessionId: "s-test",
  stepIndex: 1,
  signal: new AbortController().signal,
  ...(providerId ? { providerId } : {}),
});

async function withClip(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "audio-listen-"));
  await writeFile(join(root, "note.wav"), WAV);
  return root;
}

describe("audio.listen (ATO-497)", () => {
  it("sends the clip and the prompt to a model that hears", async () => {
    const root = await withClip();
    const provider = fakeProvider({ audio: true });
    const tool = buildAudioListenTool({ provider, maxAudioBytes: 1024 });
    const result = await tool.run({ path: "note.wav", prompt: "What is said?" }, ctx(root));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hello from the clip");
    expect(result.details).toMatchObject({ format: "wav", bytes: WAV.byteLength });
    const request = provider.describeAudio.mock.calls[0]![0] as AudioRequest;
    expect(request.prompt).toBe("What is said?");
    expect(request.audio.format).toBe("wav");
  });

  it("uses a transcription prompt when none is given", async () => {
    const root = await withClip();
    const provider = fakeProvider({ audio: true });
    await buildAudioListenTool({ provider, maxAudioBytes: 1024 }).run({ path: "note.wav" }, ctx(root));
    expect((provider.describeAudio.mock.calls[0]![0] as AudioRequest).prompt).toBe(DEFAULT_AUDIO_PROMPT);
  });

  it("refuses without a call on a model that cannot hear, pointing at the transcription skill", async () => {
    const root = await withClip();
    const provider = fakeProvider({ audio: false });
    const result = await buildAudioListenTool({ provider, maxAudioBytes: 1024 }).run(
      { path: "note.wav" },
      ctx(root),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("audio-transcribe");
    expect(result.details).toMatchObject({ retryable: false, reason: "model-cannot-hear" });
    expect(provider.describeAudio).not.toHaveBeenCalled();
  });

  it("treats a provider without describeAudio as one that cannot hear", async () => {
    const root = await withClip();
    const result = await buildAudioListenTool({
      provider: fakeProvider({ audio: true, withMethod: false }),
      maxAudioBytes: 1024,
    }).run({ path: "note.wav" }, ctx(root));
    expect(result.details).toMatchObject({ reason: "model-cannot-hear" });
  });

  it("turns a capability that flipped under the call into the same refusal", async () => {
    const root = await withClip();
    const provider = fakeProvider({
      audio: true,
      onCall: async () => {
        throw new AudioUnsupportedError("llama.cpp");
      },
    });
    const result = await buildAudioListenTool({ provider, maxAudioBytes: 1024 }).run(
      { path: "note.wav" },
      ctx(root),
    );
    expect(result.details).toMatchObject({ reason: "model-cannot-hear" });
  });

  it("resolves the provider per call from the step's pinned id", async () => {
    const root = await withClip();
    const provider = fakeProvider({ audio: true });
    const lookup = vi.fn((id: string | undefined) => (id === "worker" ? provider : undefined));
    const tool = buildAudioListenTool({ provider: lookup, maxAudioBytes: 1024 });
    expect((await tool.run({ path: "note.wav" }, ctx(root, "worker"))).status).toBe("ok");
    const missing = await tool.run({ path: "note.wav" }, ctx(root, "gone"));
    expect(missing.status).toBe("error");
    expect(missing.summary).toContain("not configured");
  });

  it("rejects a missing path and a non-audio file", async () => {
    const root = await withClip();
    await writeFile(join(root, "notes.txt"), "plain text, not audio");
    const tool = buildAudioListenTool({ provider: fakeProvider({ audio: true }), maxAudioBytes: 1024 });
    expect((await tool.run({}, ctx(root))).summary).toMatch(/path/);
    expect((await tool.run({ path: "notes.txt" }, ctx(root))).summary).toMatch(/only WAV and MP3/);
  });

  it("is registered only when audio input is switched on", () => {
    const registered: string[] = [];
    const registry = { register: (tool: { name: string }) => registered.push(tool.name) };
    const provider = fakeProvider({ audio: true });
    registerAudioTools(registry as never, { enabled: false, provider, maxAudioBytes: 1 });
    registerAudioTools(registry as never, { enabled: true, provider: undefined, maxAudioBytes: 1 });
    expect(registered).toEqual([]);
    registerAudioTools(registry as never, { enabled: true, provider, maxAudioBytes: 1 });
    expect(registered).toEqual(["audio.listen"]);
  });
});
