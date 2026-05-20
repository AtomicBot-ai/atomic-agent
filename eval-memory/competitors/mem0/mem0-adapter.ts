/**
 * Mem0 competitor adapter — scaffold.
 *
 * Mem0 ships an OpenAI-style HTTP API at https://api.mem0.ai. Three
 * key calls land on the adapter surface:
 *
 *   POST /v1/memories           — ingest a turn (writes embeddings + facts)
 *   POST /v1/memories/search    — recall top-K
 *   DELETE /v1/memories?user_id — reset a session
 *
 * The adapter is **not yet implemented end-to-end** because:
 *
 *  1. Authentication. Mem0 cloud requires `MEM0_API_KEY` and a paid
 *     plan (free tier is rate-limited below campaign load). The
 *     campaign-orchestrator probe surfaces missing env in the run
 *     summary instead of failing silently.
 *  2. The self-hosted Mem0 OSS variant is Python + vector-db (Qdrant
 *     by default) — running it requires `docker compose`. The
 *     adapter's `close()` would need to manage the container
 *     lifetime, which is best done from a dedicated orchestrator
 *     script (`scripts/run-mem0-docker.mjs`, deferred).
 *
 * The skeleton below is wired enough that the campaign loop's
 * iteration shape is honest — a future patch only needs to fill in
 * the four request bodies + JSON response parsing.
 */

import {
  CompetitorAdapterError,
  type CompetitorAdapter,
  type CompetitorAdapterFactory,
  type CompetitorAdapterCreateOptions,
  type CompetitorIngestResult,
  type CompetitorRecallRequest,
  type CompetitorRecallResult,
  type CompetitorTurn,
} from "../competitor-adapter.js";

const NAME = "mem0";
const LABEL = "Mem0 (cloud)";

class Mem0Adapter implements CompetitorAdapter {
  readonly name = NAME;
  readonly label = LABEL;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly userIdPrefix: string,
  ) {}

  async ensureSession(_sessionId: string): Promise<void> {
    // Mem0 creates user namespaces lazily on first write — no-op.
  }

  async ingest(_turn: CompetitorTurn): Promise<CompetitorIngestResult> {
    throw new CompetitorAdapterError(
      "ingest() not implemented — fill in POST /v1/memories body",
      NAME,
    );
    // POST `${baseUrl}/v1/memories` with body:
    //   { messages: [{ role: turn.speaker, content: turn.text }],
    //     user_id: `${userIdPrefix}-${turn.sessionId}`,
    //     metadata: { turnId: turn.turnId, timestamp: turn.timestamp } }
    // Authorization: Bearer ${apiKey}
  }

  async recall(_req: CompetitorRecallRequest): Promise<CompetitorRecallResult> {
    throw new CompetitorAdapterError(
      "recall() not implemented — fill in POST /v1/memories/search body",
      NAME,
    );
    // POST `${baseUrl}/v1/memories/search` with body:
    //   { query: req.query, user_id: `${userIdPrefix}-${req.sessionId}`,
    //     limit: req.k }
  }

  async reset(_sessionId: string): Promise<void> {
    throw new CompetitorAdapterError(
      "reset() not implemented — fill in DELETE /v1/memories?user_id=…",
      NAME,
    );
  }

  async close(): Promise<void> {
    // No persistent connections to close; the adapter uses fetch().
  }

  // Suppress unused-private-property warnings until the calls land.
  readonly _suppressUnused = [this.apiKey, this.baseUrl, this.userIdPrefix];
}

export const mem0Factory: CompetitorAdapterFactory = {
  name: NAME,
  label: LABEL,
  requirements: {
    envVars: ["MEM0_API_KEY"],
    description:
      "Mem0 cloud API (https://app.mem0.ai). Set MEM0_API_KEY and " +
      "optionally MEM0_BASE_URL (defaults to https://api.mem0.ai) and " +
      "MEM0_USER_ID_PREFIX (defaults to 'atomic-eval').",
  },
  create: async (
    _opts: CompetitorAdapterCreateOptions,
  ): Promise<CompetitorAdapter> => {
    const apiKey = process.env.MEM0_API_KEY ?? "";
    if (!apiKey) {
      throw new CompetitorAdapterError(
        "MEM0_API_KEY is not set — adapter cannot be constructed",
        NAME,
      );
    }
    const baseUrl = process.env.MEM0_BASE_URL ?? "https://api.mem0.ai";
    const userIdPrefix = process.env.MEM0_USER_ID_PREFIX ?? "atomic-eval";
    return new Mem0Adapter(apiKey, baseUrl, userIdPrefix);
  },
};
