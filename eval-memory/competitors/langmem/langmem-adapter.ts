/**
 * LangMem competitor adapter — scaffold.
 *
 * LangMem (https://github.com/langchain-ai/langmem) is LangChain's
 * memory abstraction layer. It is a Python library and the cleanest
 * way to bridge into TypeScript is one of:
 *
 *   (a) `langgraph` Python service exposed via FastAPI, subprocess-
 *       launched by the orchestrator.
 *   (b) `@langchain/langgraph` JS port (does not currently host
 *       `langmem`'s memory tools as first-class — semi-shimmed).
 *
 * Path (a) is more faithful but requires Python + the langmem pip
 * package + an OpenAI API key (langmem uses OpenAI by default for
 * its memory-extraction LLM call). Path (b) is doable today but
 * compares us against a less-featureful shim, which would be
 * unfair.
 *
 * The scaffold below targets path (a) — the adapter is a thin HTTP
 * client over a future `langmem-service` that the campaign starts
 * as a subprocess. Endpoints mirror the langmem Python API
 * (`store`, `search`, `delete`) so the wiring is a JSON-encoding
 * exercise rather than a new design.
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

const NAME = "langmem";
const LABEL = "LangMem (LangChain memory tools, via Python bridge)";

class LangMemAdapter implements CompetitorAdapter {
  readonly name = NAME;
  readonly label = LABEL;

  constructor(private readonly bridgeUrl: string) {}

  async ensureSession(_sessionId: string): Promise<void> {
    // LangMem uses (namespace, key) addressing — sessions become a
    // top-level namespace entry. No upfront creation needed.
  }

  async ingest(_turn: CompetitorTurn): Promise<CompetitorIngestResult> {
    throw new CompetitorAdapterError(
      "ingest() not implemented — POST to ${bridgeUrl}/store with " +
        "{namespace: turn.sessionId, key: turn.turnId, value: turn.text}",
      NAME,
    );
  }

  async recall(_req: CompetitorRecallRequest): Promise<CompetitorRecallResult> {
    throw new CompetitorAdapterError(
      "recall() not implemented — POST to ${bridgeUrl}/search with " +
        "{namespace: req.sessionId, query: req.query, limit: req.k}",
      NAME,
    );
  }

  async reset(_sessionId: string): Promise<void> {
    throw new CompetitorAdapterError(
      "reset() not implemented — DELETE ${bridgeUrl}/namespace/{sessionId}",
      NAME,
    );
  }

  async close(): Promise<void> {
    // The Python bridge process is managed by the orchestrator, not
    // by the adapter.
  }

  readonly _suppressUnused = [this.bridgeUrl];
}

export const langMemFactory: CompetitorAdapterFactory = {
  name: NAME,
  label: LABEL,
  requirements: {
    envVars: ["LANGMEM_BRIDGE_URL", "OPENAI_API_KEY"],
    description:
      "LANGMEM_BRIDGE_URL points to the Python FastAPI sidecar that " +
      "wraps the langmem package. OPENAI_API_KEY is forwarded for the " +
      "extraction sub-call. Start the bridge with " +
      "`python eval-memory/competitors/langmem/bridge.py` (deferred).",
  },
  create: async (
    _opts: CompetitorAdapterCreateOptions,
  ): Promise<CompetitorAdapter> => {
    const bridgeUrl = process.env.LANGMEM_BRIDGE_URL ?? "";
    if (!bridgeUrl) {
      throw new CompetitorAdapterError(
        "LANGMEM_BRIDGE_URL is not set — start the Python bridge first",
        NAME,
      );
    }
    return new LangMemAdapter(bridgeUrl);
  },
};
