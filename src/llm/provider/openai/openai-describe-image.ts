import type { VisionRequest, VisionResult } from "../llm-provider.js";
import type { OpenAiHttpDeps } from "./openai-http.js";
import { openAiPostJson } from "./openai-http.js";

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
    max_tokens: request.maxTokens ?? 512,
    temperature: request.temperature ?? 0.1,
    stream: false,
  };
  const start = Date.now();
  const json = await openAiPostJson(deps, "/v1/chat/completions", body, request);
  const text =
    (json.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]
      ?.message?.content ?? "";
  return { text: String(text).trim(), durationMs: Date.now() - start };
}
