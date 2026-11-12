import type { ModelProfile } from "../../model-profile.js";
import type {
  AudioRequest,
  ProviderCapabilities,
  VisionResult,
} from "../llm-provider.js";
import { postMultimodalChat } from "./llama-server-vision.js";

/**
 * The audio half of a local link's capabilities: what the loaded
 * model's `/props` said (`modalities.audio`). Nothing else turns it on —
 * a model whose projector has no audio encoder answers an audio part
 * with an error, and the transcription skill already covers it.
 */
export function resolveAudioCapabilities(
  profile: ModelProfile,
): Pick<ProviderCapabilities, "audio" | "audioSource"> {
  const audio = profile.audio;
  if (audio?.supported === true) {
    return { audio: true, audioSource: audio.source };
  }
  return { audio: false, audioSource: "absent" };
}

/**
 * One audio clip plus a prompt, sent to llama-server as an OpenAI
 * `input_audio` part (base64 + `wav`/`mp3`), the shape its
 * multimodal chat route reads for an audio-capable projector.
 */
export async function describeAudioViaLlamaServer(opts: {
  request: AudioRequest;
  baseUrl: string;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<VisionResult> {
  const { request } = opts;
  return postMultimodalChat({
    label: "audio",
    userContent: [
      {
        type: "input_audio",
        input_audio: {
          data: Buffer.from(request.audio.bytes).toString("base64"),
          format: request.audio.format,
        },
      },
      { type: "text", text: request.prompt },
    ],
    baseUrl: opts.baseUrl,
    requestTimeoutMs: opts.requestTimeoutMs,
    fetchImpl: opts.fetchImpl,
    // A transcript runs longer than an image description.
    maxTokens: request.maxTokens ?? 2048,
    temperature: request.temperature ?? 0.1,
    signal: request.signal,
  });
}
