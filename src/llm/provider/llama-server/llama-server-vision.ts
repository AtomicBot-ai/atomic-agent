import { getConfig } from "../../../config/index.js";
import type { ModelProfile } from "../../model-profile.js";
import type { ProviderCapabilities } from "../llm-provider.js";
import type { VisionRequest, VisionResult } from "../llm-provider.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

export function resolveVisionCapabilities(opts: {
  profile: ModelProfile;
  visionEnabledByConfig: boolean;
  visionAutoDetect: boolean;
}): Pick<ProviderCapabilities, "vision" | "visionSource"> {
  if (!opts.visionEnabledByConfig) {
    return { vision: false, visionSource: "config-disabled" };
  }
  if (!opts.visionAutoDetect) {
    return { vision: true, visionSource: "auto-detect-disabled" };
  }
  return {
    vision: opts.profile.vision.supported,
    visionSource: opts.profile.vision.source,
  };
}

export function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  return "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export async function describeImageViaLlamaServer(opts: {
  request: VisionRequest;
  baseUrl: string;
  maxImageBytes: number;
  maxImagesPerCall: number;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<VisionResult> {
  const { request } = opts;
  if (request.images.length === 0) {
    throw new Error("vision.describe requires at least one image");
  }
  if (request.images.length > opts.maxImagesPerCall) {
    throw new Error(
      `vision.describe accepts at most ${opts.maxImagesPerCall} images per call`,
    );
  }
  for (const img of request.images) {
    if (img.bytes.byteLength > opts.maxImageBytes) {
      throw new Error(
        `image #${img.id} exceeds maxImageBytes (${opts.maxImageBytes})`,
      );
    }
  }

  const config = getConfig();
  const url = new URL("/v1/chat/completions", opts.baseUrl).toString();

  const userContent: Array<
    | { type: "image_url"; image_url: { url: string } }
    | { type: "text"; text: string }
  > = [];
  for (const img of request.images) {
    const mime = detectImageMime(img.bytes);
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${mime};base64,${bytesToBase64(img.bytes)}`,
      },
    });
  }
  userContent.push({ type: "text", text: request.prompt });

  const body = JSON.stringify({
    messages: [{ role: "user", content: userContent }],
    max_tokens: request.maxTokens ?? 512,
    temperature: request.temperature ?? 0.1,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_format: "none",
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.localModels.apiKey) {
    headers.authorization = `Bearer ${config.localModels.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.requestTimeoutMs);
  const start = Date.now();
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`vision request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `vision request returned http ${res.status}: ${errBody.slice(0, 200)}`,
    );
  }
  const json = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
  const content = json?.choices?.[0]?.message?.content ?? "";

  return {
    text: content.trim(),
    durationMs: Date.now() - start,
  };
}
