/**
 * Common surface every external memory baseline (Mem0, Zep,
 * LangMem, …) implements so LoCoMo / LongMemEval / L2 runners can
 * iterate over `[ourselves, competitor1, competitor2, …]` without
 * special-casing the loop.
 *
 * The shape mirrors the **minimum** every long-term memory product
 * exposes: ingest a turn, recall what's relevant, and reset between
 * scenarios. Concrete adapters wrap their respective SDKs.
 *
 * What it intentionally does NOT cover:
 *
 *  - The agent loop. Competitors usually do not own a tool-calling
 *    agent — they own only the memory layer. Campaign runners feed
 *    the ingested turns into the competitor, then surface the recall
 *    output as plain text into a stock LLM call (a `chat completion`
 *    on the same llama-server we test ourselves on). This keeps the
 *    comparison apples-to-apples: same model, same prompt template,
 *    different memory backend.
 *  - Voting / lessons / procedures equivalents. Most competitors
 *    have none. The L2 evaluation explicitly notes "competitors have
 *    no skill accumulation" as a design difference, not as a `bug`.
 *
 * Adapters MUST be **stateless across scenarios** when `reset()` is
 * called. A scenario boundary is the boundary at which the campaign
 * declares "this is a new conversation, forget everything you knew".
 */

export interface CompetitorTurn {
  /** Stable session id within a scenario; competitors that key by
   *  conversation use this as their conversation handle. */
  sessionId: string;
  /** Stable per-turn id (ordered). */
  turnId: string;
  /** Speaker label, typically `"user"` / `"assistant"`. */
  speaker: string;
  /** Verbatim text of the turn. */
  text: string;
  /** Optional ISO timestamp. LoCoMo + LongMemEval emit per-session
   *  dates; competitors that key on time (Zep) consume them. */
  timestamp?: string;
}

export interface CompetitorRecallRequest {
  sessionId: string;
  /** The user query to find relevant memories for. */
  query: string;
  /** How many memories to surface. Adapter may return fewer. */
  k: number;
}

export interface CompetitorMemoryItem {
  /** Adapter-specific opaque id (memory row, vector hit, etc.). */
  id: string;
  /** The memory text to inject into the LLM prompt. */
  text: string;
  /** When known, the source turn ids the memory was derived from. */
  sourceTurnIds?: readonly string[];
  /** Similarity score in the adapter's native scale. Higher is
   *  better; not comparable across adapters. */
  score?: number;
}

export interface CompetitorRecallResult {
  items: readonly CompetitorMemoryItem[];
  /** End-to-end latency of the recall call (ms). */
  durationMs: number;
}

export interface CompetitorIngestResult {
  /** End-to-end latency of the ingest call (ms). */
  durationMs: number;
}

export interface CompetitorAdapter {
  /** Stable, kebab-case id used in CSV / report column headers. */
  readonly name: string;
  /** Human-readable label for markdown summaries. */
  readonly label: string;
  /**
   * Initialise any session-scoped state the adapter needs. Idempotent
   * — calling twice on the same `sessionId` must be a no-op or a
   * fresh start (adapter's choice; the campaign always calls
   * `reset(sessionId)` first when a fresh start is wanted).
   */
  ensureSession(sessionId: string): Promise<void>;
  /**
   * Feed one turn into the competitor's memory. Adapters that lazy-
   * write on recall MUST still record this call so subsequent
   * `recall()` sees it.
   */
  ingest(turn: CompetitorTurn): Promise<CompetitorIngestResult>;
  /** Surface up to `k` items relevant to the query. */
  recall(req: CompetitorRecallRequest): Promise<CompetitorRecallResult>;
  /** Drop every memory written for the given session. */
  reset(sessionId: string): Promise<void>;
  /**
   * Tear the adapter down — close HTTP clients, kill docker
   * containers managed by us, etc. Idempotent.
   */
  close(): Promise<void>;
}

export class CompetitorAdapterError extends Error {
  constructor(message: string, public readonly adapterName: string) {
    super(`[${adapterName}] ${message}`);
    this.name = "CompetitorAdapterError";
  }
}

/**
 * Adapters declare upfront what they need to actually run. The
 * campaign orchestrator inspects this and skips the adapter (with a
 * recorded reason in the summary) when a precondition is missing —
 * we never want a missing API key to silently kill a 5-hour run.
 */
export interface CompetitorAdapterRequirements {
  /** Env vars the adapter expects to find populated. */
  envVars: readonly string[];
  /** Optional human description shown in the "skipped" reason. */
  description?: string;
}

export interface CompetitorAdapterFactory {
  readonly name: string;
  readonly label: string;
  readonly requirements: CompetitorAdapterRequirements;
  /**
   * Construct the adapter. Throws `CompetitorAdapterError` when an
   * unavoidable precondition is broken (e.g. wrong SDK version).
   */
  create(opts: CompetitorAdapterCreateOptions): Promise<CompetitorAdapter>;
}

export interface CompetitorAdapterCreateOptions {
  /**
   * llama-server URL for adapters that build summaries / embeddings
   * on top of a local model. Adapters that go to a cloud (Mem0,
   * Zep cloud, …) ignore this.
   */
  llamaUrl?: string;
}

/**
 * Probe an adapter factory's requirements against `process.env` and
 * return a sorted list of missing env vars. Returns `[]` when ready.
 */
export function probeAdapterRequirements(
  factory: CompetitorAdapterFactory,
): readonly string[] {
  const missing: string[] = [];
  for (const name of factory.requirements.envVars) {
    const v = process.env[name];
    if (!v || v.trim().length === 0) missing.push(name);
  }
  return missing.sort();
}
