import { getConfig } from "../../../config/index.js";
import { llamaEndpointUrl } from "../../llama-endpoint-url.js";
import { apiKeyForUrl } from "../../../local-llm/server/managed-api-key.js";
import type { ModelProfile } from "../../model-profile.js";
import type { ProviderCapabilities } from "../llm-provider.js";
import type { VisionRequest, VisionResult } from "../llm-provider.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
    /**
     * `"stop"` when the model finished, `"length"` when it ran into the
     * token cap. Load-bearing for the `reasoning_content` rescue below:
     * unmodelled, a half-finished think-stream is indistinguishable
     * from a complete answer.
     */
    finish_reason?: string;
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
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
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
  const url = llamaEndpointUrl(opts.baseUrl, "/v1/chat/completions");

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

  const maxTokens = request.maxTokens ?? 512;
  const body = JSON.stringify({
    messages: [{ role: "user", content: userContent }],
    max_tokens: maxTokens,
    temperature: request.temperature ?? 0.1,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_format: "none",
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  // The key for this base, not `localModels.apiKey`: an overridden base
  // may be another host, which must not get the managed daemons' key.
  const apiKey = apiKeyForUrl(opts.baseUrl, config);
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  // The deadline has to cover the body, not just the headers. It used to
  // be cleared the moment `fetchImpl` resolved, so everything after the
  // status line ran with no deadline of ours at all — and undici's own
  // `bodyTimeout` is an *inactivity* timer, which a server dribbling one
  // byte at a time resets forever.
  const timer = setTimeout(() => controller.abort(), opts.requestTimeoutMs);
  // The caller's signal is the user's Esc (`ToolContext.signal` reaches
  // here through `vision.describe`). Unlinked, a cancelled turn left a
  // wedged vision call holding the socket and the slot until the
  // deadline; linked the same way `LlamaServerClient.complete()` links
  // it, the abort reason reaches the caller as the failure.
  const externalSignal = request.signal;
  // Carrying the caller's reason across is what keeps the failure
  // readable: aborting our own controller bare would report every user
  // cancel as "This operation was aborted".
  const onAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const start = Date.now();
  let res: Response;
  let rawBody = "";
  let bodyError: Error | null = null;
  try {
    res = await opts.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    // Drain to text inside the deadline: both the success and the error
    // branch below need the body.
    try {
      rawBody = await res.text();
    } catch (err) {
      // Held, not thrown: a non-2xx still has a status worth reporting,
      // and an abort that landed while reading its error body must not
      // downgrade a diagnosable `http 500` to "something aborted".
      bodyError = err instanceof Error ? err : new Error(String(err));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`vision request failed: ${message}`);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
  if (!res.ok) {
    throw new Error(
      `vision request returned http ${res.status}: ${rawBody.slice(0, 200)}`,
    );
  }
  if (bodyError) {
    throw new Error(`vision request failed: ${bodyError.message}`);
  }
  let json: ChatCompletionResponse;
  try {
    json = JSON.parse(rawBody) as ChatCompletionResponse;
  } catch (err) {
    // A body that does not parse used to be swallowed into `null` and
    // returned as an empty description, which the tool caller reads as
    // "the model saw nothing" rather than "the server answered garbage".
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`vision request failed: ${message}`);
  }
  const choice = json?.choices?.[0];
  const message = choice?.message;
  let text = (message?.content ?? "").trim();
  // Reasoning-only answer: `content` empty because the model parked the
  // description in its think channel. `describeImageViaOpenAi` already
  // rescues that; here it used to resolve as an empty description.
  if (text.length === 0 && typeof message?.reasoning_content === "string") {
    // Except when the reply hit the token cap. This request asks for no
    // reasoning channel at all (`enable_thinking: false` +
    // `reasoning_format: "none"`), so a server answering with one has
    // ignored both — and at 512 tokens, eight times tighter than the
    // OpenAI path's 4096, that channel is most often a deliberation cut
    // in half rather than a finished description in the wrong field.
    // Handing it up would render half a thought to the user as "what is
    // in the image"; failing names the cap, which is the knob to move.
    if (choice?.finish_reason === "length") {
      throw new Error(
        `vision request produced no description: the reply hit its ${maxTokens}-token cap inside the model's reasoning channel`,
      );
    }
    text = message.reasoning_content.trim();
  }

  return {
    text,
    durationMs: Date.now() - start,
  };
}
