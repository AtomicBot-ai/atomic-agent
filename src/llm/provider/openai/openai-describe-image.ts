import type { VisionRequest, VisionResult } from "../llm-provider.js";
import type { OpenAiHttpDeps } from "./openai-http.js";
import { openAiPostJson } from "./openai-http.js";
import { normaliseMessageContent } from "./openai-normalise-response.js";

export async function describeImageViaOpenAi(
  deps: OpenAiHttpDeps,
  defaultChatModel: string,
  request: VisionRequest,
): Promise<VisionResult> {
  const userContent: Array<
    | { type: "image_url"; image_url: { url: string } }
    | { type: "text"; text: string }
  > = [];
  for (const img of request.images) {
    const b64 = Buffer.from(img.bytes).toString("base64");
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${b64}` },
    });
  }
  userContent.push({ type: "text", text: request.prompt });
  const body = {
    model: defaultChatModel,
    messages: [{ role: "user", content: userContent }],
    // Reasoning models (Qwen3.8, DeepSeek-R1) spend completion tokens on
    // their think channel before any visible description. The old 512
    // cap left them truncating mid-thought and returning empty or
    // clipped descriptions, which sent the agent loop into re-crop
    // spirals. 4096 leaves room for thinking plus a detailed answer.
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0.1,
    stream: false,
  };
  const start = Date.now();
  const json = await openAiPostJson(deps, "/v1/chat/completions", body, request);
  const message =
    (json.choices as Array<{ message?: Record<string, unknown> }> | undefined)?.[0]
      ?.message ?? {};
  let text = normaliseMessageContent(message.content).trim();
  // Reasoning-only response: the model answered inside its think channel
  // and left `content` empty. The reasoning body is the best available
  // description — better than returning an empty string the tool caller
  // treats as "saw nothing".
  if (text.length === 0 && typeof message.reasoning_content === "string") {
    text = message.reasoning_content.trim();
  }
  return { text, durationMs: Date.now() - start };
}
