/**
 * Zep competitor adapter — scaffold.
 *
 * Zep (https://getzep.com) is the "temporal knowledge graph" memory
 * product. It runs as a local docker service (their published
 * compose file is `getzep/zep`) and exposes a REST API on
 * `http://localhost:8000`.
 *
 * Reference shape:
 *
 *   POST   /api/v2/sessions             — create a session
 *   POST   /api/v2/messages             — append a message
 *   POST   /api/v2/memory/search        — recall top-K from a session
 *   DELETE /api/v2/sessions/{sessionId} — wipe the session
 *
 * Not implemented end-to-end because the container lifecycle is best
 * owned by a separate `scripts/run-zep-docker.mjs` orchestrator that
 * is itself outside the scope of the current Phase 5 scaffold — the
 * agent here is the SDK wrapper, not the docker manager.
 *
 * Reachable Zep deployments are detected by probing `/api/health` at
 * `ZEP_BASE_URL`; when the probe fails the adapter is skipped with a
 * recorded reason instead of throwing mid-campaign.
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

const NAME = "zep";
const LABEL = "Zep (local docker)";

class ZepAdapter implements CompetitorAdapter {
  readonly name = NAME;
  readonly label = LABEL;

  constructor(private readonly baseUrl: string) {}

  async ensureSession(_sessionId: string): Promise<void> {
    throw new CompetitorAdapterError(
      "ensureSession() not implemented — fill in POST /api/v2/sessions",
      NAME,
    );
  }

  async ingest(_turn: CompetitorTurn): Promise<CompetitorIngestResult> {
    throw new CompetitorAdapterError(
      "ingest() not implemented — fill in POST /api/v2/messages",
      NAME,
    );
  }

  async recall(_req: CompetitorRecallRequest): Promise<CompetitorRecallResult> {
    throw new CompetitorAdapterError(
      "recall() not implemented — fill in POST /api/v2/memory/search",
      NAME,
    );
  }

  async reset(_sessionId: string): Promise<void> {
    throw new CompetitorAdapterError(
      "reset() not implemented — fill in DELETE /api/v2/sessions/{sessionId}",
      NAME,
    );
  }

  async close(): Promise<void> {
    // No persistent connections to close.
  }

  readonly _suppressUnused = [this.baseUrl];
}

export const zepFactory: CompetitorAdapterFactory = {
  name: NAME,
  label: LABEL,
  requirements: {
    envVars: ["ZEP_BASE_URL"],
    description:
      "Zep server URL (default expected at http://localhost:8000). " +
      "Bring the container up with `docker compose` per https://github.com/getzep/zep.",
  },
  create: async (
    _opts: CompetitorAdapterCreateOptions,
  ): Promise<CompetitorAdapter> => {
    const baseUrl = process.env.ZEP_BASE_URL ?? "http://localhost:8000";
    // A health probe lives here in the real impl: failing it must
    // throw `CompetitorAdapterError` so the orchestrator skips the
    // adapter with the recorded reason.
    return new ZepAdapter(baseUrl);
  },
};
