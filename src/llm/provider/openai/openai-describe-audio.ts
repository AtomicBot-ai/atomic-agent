import type { AudioRequest, VisionResult } from "../llm-provider.js";
import type { OpenAiHttpDeps } from "./openai-http.js";
import {
  postUserPartsViaOpenAi,
  type DescribeImageBodyOptions,
} from "./openai-describe-image.js";

/**
 * Send one audio clip and a prompt to the chat model as an OpenAI
 * `input_audio` part (`{ data: <base64>, format: "wav" | "mp3" }`), the
 * shape OpenAI, OpenRouter and llama-server read for audio-capable
 * models. The audio goes first and the instruction after it, as with
 * images.
 */
export async function describeAudioViaOpenAi(
  deps: OpenAiHttpDeps,
  defaultChatModel: string,
  request: AudioRequest,
  apiPathPrefix = "/v1",
  providerPreferences?: Record<string, unknown>,
  bodyOptions: DescribeImageBodyOptions = {},
): Promise<VisionResult> {
  return postUserPartsViaOpenAi(
    deps,
    defaultChatModel,
    [
      {
        type: "input_audio",
        input_audio: {
          data: Buffer.from(request.audio.bytes).toString("base64"),
          format: request.audio.format,
        },
      },
      { type: "text", text: request.prompt },
    ],
    request,
    apiPathPrefix,
    providerPreferences,
    bodyOptions,
  );
}
