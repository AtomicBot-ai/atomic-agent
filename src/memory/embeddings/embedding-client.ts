/**
 * Memory-v2 phase 1B. Embedding client abstraction.
 *
 * The runtime never talks to llama-server directly for embeddings —
 * it goes through an `EmbeddingClient`. This indirection serves two
 * goals:
 *
 *   1. **Graceful degradation.** If the embedding daemon is missing
 *      / down / errors, `embed()` throws a typed error that the
 *      caller (`HybridRecall`, `EmbeddingWriter`) catches and falls
 *      back to FTS5-only — the runtime never crashes because the
 *      second daemon is unavailable.
 *
 *   2. **Test isolation.** A deterministic in-memory implementation
 *      (`InMemoryEmbeddingClient`) lets tests assert paraphrase
 *      recall without spinning up a real llama-server.
 *
 * The HTTP implementation talks to `POST /embedding` on a dedicated
 * second `llama-server` instance — see `daemon-lifecycle.ts` for the
 * lifecycle wiring. **Never the chat daemon's URL**, because llama-
 * server cannot serve `/completion` and `/embedding` from the same
 * process (the `--embeddings` flag forces pooling-only mode).
 */

export class EmbeddingUnavailableError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EmbeddingUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface EmbedRequest {
  text: string;
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** Raw float32 vector. Length must equal `EmbeddingClient.dim`. */
  vector: Float32Array;
  /** Model identifier the daemon reported (free-form string). */
  model: string;
}

export interface EmbeddingClient {
  /** Output dimensionality of `embed()` results. Stable per client. */
  readonly dim: number;
  /** Free-form model id used as the `model` column in `memory_embeddings`. */
  readonly model: string;
  /**
   * Compute an embedding for `text`. MUST throw
   * `EmbeddingUnavailableError` (not generic `Error`) on transport
   * failure so callers can branch on the typed error rather than
   * sniffing `message`.
   */
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

interface LlamaServerEmbeddingResponse {
  /**
   * llama-server `/embedding` returns either:
   *   - `{ embedding: number[] }` for `--pooling` enabled servers, or
   *   - `[{ embedding: number[] }]` (OpenAI-shape) on `/v1/embeddings`.
   * We accept both shapes so the client survives a llama.cpp version
   * bump without forcing the caller to know which API surface is live.
   */
  embedding?: number[] | number[][];
  data?: Array<{ embedding: number[] }>;
}

export interface LlamaEmbeddingClientOptions {
  /** Base URL of the embedding-only `llama-server`, e.g. `http://127.0.0.1:19092`. */
  url: string;
  /** Output dimension declared by the embedding model — pinned for parity checks. */
  dim: number;
  /** Free-form model id for the `memory_embeddings.model` column. */
  model: string;
  /** Request timeout (ms). Defaults to 10_000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Default HTTP-based `EmbeddingClient` for managed-mode embedding
 * daemons. Speaks the llama.cpp `/embedding` endpoint.
 */
export class LlamaEmbeddingClient implements EmbeddingClient {
  public readonly dim: number;
  public readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: LlamaEmbeddingClientOptions) {
    if (!Number.isInteger(opts.dim) || opts.dim <= 0) {
      throw new Error(
        `LlamaEmbeddingClient: dim must be a positive integer, got ${opts.dim}`,
      );
    }
    this.dim = opts.dim;
    this.model = opts.model;
    this.url = opts.url.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = mergeSignals(req.signal, ctrl.signal);
    try {
      const res = await this.fetchFn(`${this.url}/embedding`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: req.text }),
        signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "(no body)");
        throw new EmbeddingUnavailableError(
          `embedding daemon returned HTTP ${res.status}: ${txt.slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as LlamaServerEmbeddingResponse;
      const raw = extractEmbeddingArray(body);
      if (!raw) {
        throw new EmbeddingUnavailableError(
          "embedding daemon response shape unrecognised",
        );
      }
      if (raw.length !== this.dim) {
        throw new EmbeddingUnavailableError(
          `embedding dim mismatch: expected ${this.dim}, got ${raw.length}`,
        );
      }
      const out = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) out[i] = raw[i]!;
      return { vector: out, model: this.model };
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      throw new EmbeddingUnavailableError(
        `embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractEmbeddingArray(
  body: LlamaServerEmbeddingResponse,
): number[] | null {
  if (Array.isArray(body.embedding) && typeof body.embedding[0] === "number") {
    return body.embedding as number[];
  }
  if (
    Array.isArray(body.embedding) &&
    Array.isArray(body.embedding[0]) &&
    typeof body.embedding[0]?.[0] === "number"
  ) {
    // llama.cpp /embedding occasionally returns nested arrays when
    // multiple sequences are batched. We always send one — take [0].
    return body.embedding[0] as number[];
  }
  if (Array.isArray(body.data) && body.data[0]?.embedding) {
    return body.data[0].embedding;
  }
  return null;
}

function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  const ctrl = new AbortController();
  const onAbortA = () => ctrl.abort(a.reason);
  const onAbortB = () => ctrl.abort(b.reason);
  if (a.aborted) ctrl.abort(a.reason);
  else if (b.aborted) ctrl.abort(b.reason);
  else {
    a.addEventListener("abort", onAbortA, { once: true });
    b.addEventListener("abort", onAbortB, { once: true });
  }
  return ctrl.signal;
}
