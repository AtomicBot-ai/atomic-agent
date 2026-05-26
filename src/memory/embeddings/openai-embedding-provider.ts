import { normalizeOpenRouterBaseUrl } from "../../llm/provider/openrouter/openrouter-provider.js";
import {
  EmbeddingUnavailableError,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingClient,
} from "./embedding-client.js";

export interface OpenAiEmbeddingProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible `POST /v1/embeddings` client.
 */
export class OpenAiEmbeddingProvider implements EmbeddingClient {
  readonly dim: number;
  readonly model: string;

  constructor(private readonly options: OpenAiEmbeddingProviderOptions) {
    this.dim = options.dim;
    this.model = options.model;
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    try {
      const res = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/v1/embeddings`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.options.model,
            input: req.text,
          }),
          signal: req.signal,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new EmbeddingUnavailableError(
          `embeddings http ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
        model?: string;
      };
      const vec = json.data?.[0]?.embedding;
      if (!vec || vec.length !== this.dim) {
        throw new EmbeddingUnavailableError("unexpected embedding shape");
      }
      return {
        vector: Float32Array.from(vec),
        model: json.model ?? this.model,
      };
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      throw new EmbeddingUnavailableError(
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }

}

export class OpenRouterEmbeddingProvider extends OpenAiEmbeddingProvider {
  constructor(
    options: OpenAiEmbeddingProviderOptions & {
      httpReferer?: string;
      xTitle?: string;
    },
  ) {
    const headers: Record<string, string> = {};
    if (options.httpReferer) headers["HTTP-Referer"] = options.httpReferer;
    if (options.xTitle) headers["X-Title"] = options.xTitle;
    super({
      ...options,
      baseUrl: normalizeOpenRouterBaseUrl(
        options.baseUrl ?? "https://openrouter.ai/api",
      ),
    });
  }
}
