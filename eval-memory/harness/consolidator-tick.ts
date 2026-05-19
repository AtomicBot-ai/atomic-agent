/**
 * Run the consolidator exactly once against an existing `<stateDir>`.
 *
 * Used between E2E sessions to let the agent's per-turn reflection
 * graduate into lessons / procedures without waiting for the in-
 * runtime scheduler (which only fires every `consolidator.intervalMs`
 * and is irrelevant in batch evaluation).
 *
 * This bypasses the runtime entirely — it constructs only the four
 * stores (memory, link, lesson, procedure, vote) directly against the
 * existing `<stateDir>/memory.sqlite`, runs one `runOnce()`, and
 * tears everything down. No CLI, no subprocess, no DistillRunner that
 * could call a remote LLM (we pass a no-op completer; the
 * consolidator short-circuits when there are no clusters).
 *
 * IMPORTANT: This helper is only meaningful for clusters that the
 * consolidator can *currently* detect from raw memories. In E2E
 * scenarios you should give the agent enough turns to seed the
 * `MemoryStore` with at least `consolidator.minClusterSize` related
 * episodes BEFORE calling `runConsolidatorTick` — otherwise the tick
 * is a no-op.
 */

import { resolve } from "node:path";

import { MemoryStore } from "../../src/memory/memory-store.js";
import { LinkStore } from "../../src/memory/links/link-store.js";
import { LessonStore } from "../../src/memory/lessons/lesson-store.js";
import { ProcedureStore } from "../../src/memory/procedures/procedure-store.js";
import { VoteStore } from "../../src/memory/voting/index.js";
import {
  ConsolidatorJob,
  type ConsolidatorTickResult,
} from "../../src/memory/consolidator/index.js";
import { DistillRunner } from "../../src/memory/consolidator/distill-runner.js";
import { LlamaServerClient } from "../../src/llm/llama-server-client.js";
import { createLinkGeneratorRunner } from "../../src/memory/links/link-generator-runner.js";
import { StructuredLogger, stderrSink } from "../../src/tracing/structured-logger.js";

export interface ConsolidatorTickInput {
  stateDir: string;
  /**
   * llama-server URL — we construct a `LlamaServerClient` here so the
   * distill runner sees the full `CompletionResult` shape it expects
   * (the simpler `LlmCompleteResult` used by the eval harness drops
   * `timing` / `truncated` / cache hit tokens that the consolidator
   * relies on).
   */
  llamaUrl: string;
  /** Phase 7b: when true, the distill grammar adds the procedure half. */
  withProcedure?: boolean;
  /** Override default minClusterSize (3). */
  minClusterSize?: number;
  /** Override default maxClustersPerTick (5). */
  maxClustersPerTick?: number;
  /** Override deprecation knobs — defaults are conservative for E2E. */
  deprecationAgeDays?: number;
  procedureDeprecationAgeDays?: number;
  /**
   * Eval-only "link sweep" knob. When `true` (default), before the
   * clustering pass we feed every unconsolidated memory in chunks to
   * the production `LinkGeneratorRunner`, awaiting each call so
   * `memory_links` is populated before the consolidator walks the
   * adjacency graph. This compensates for the per-turn link-
   * generator's tight 8s timeout, which Gemma-class models often
   * miss on cold reflection slots — the production runtime tolerates
   * the resulting gaps because it gradually accumulates links over
   * many sessions, but a batch E2E scenario seeds 6 episodes in 2
   * minutes and has no warm-up window.
   */
  runLinkSweep?: boolean;
  /** Chunk size for the link sweep. Default 6. */
  linkSweepChunkSize?: number;
  /** Per-chunk LLM timeout (ms) — bumped for cold sweeps. Default 45000. */
  linkSweepTimeoutMs?: number;
}

export interface LinkSweepStats {
  /** Total memories considered. */
  totalCandidates: number;
  /** Number of chunks fed to the link generator. */
  chunks: number;
  /** Sum of `linksWritten` across all chunks. */
  linksWritten: number;
}

export type ConsolidatorTickOutcome =
  | { kind: "ok"; result: ConsolidatorTickResult; linkSweep?: LinkSweepStats }
  | { kind: "no_clusters"; linkSweep?: LinkSweepStats }
  | { kind: "failed"; reason: string; linkSweep?: LinkSweepStats };

export async function runConsolidatorTick(
  input: ConsolidatorTickInput,
): Promise<ConsolidatorTickOutcome> {
  const dbFile = resolve(input.stateDir, "memory.sqlite");
  const memoryStore = new MemoryStore({
    dbFile,
    maxEntries: 5000,
  });
  const db = memoryStore.getDatabaseHandleForEmbeddings();
  const linkStore = new LinkStore({ db });
  const lessonStore = new LessonStore({ dbFile });
  const procedureStore = new ProcedureStore({ dbFile });
  const voteStore = new VoteStore({ db });
  const llamaClient = new LlamaServerClient({
    baseUrl: input.llamaUrl,
    requestTimeoutMs: 120_000,
  });
  let linkSweep: LinkSweepStats | undefined;
  try {
    // Eval-only link sweep — see `runLinkSweep` docstring.
    if (input.runLinkSweep !== false) {
      linkSweep = await runLinkSweep({
        memoryStore,
        linkStore,
        llamaClient,
        chunkSize: input.linkSweepChunkSize ?? 6,
        timeoutMs: input.linkSweepTimeoutMs ?? 60_000,
      });
    }

    const distill = new DistillRunner({
      llmComplete: llamaClient.complete.bind(llamaClient),
      slotId: -1,
      timeoutMs: 120_000,
      ...(input.withProcedure === true ? { withProcedure: true as const } : {}),
    });
    const consolidator = new ConsolidatorJob(
      {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        minClusterSize: input.minClusterSize ?? 3,
        maxClustersPerTick: input.maxClustersPerTick ?? 5,
        requireSharedTag: false,
        consolidationLeaseMs: 60_000,
        deprecationAgeMs: (input.deprecationAgeDays ?? 30) * 86_400_000,
        procedureDeprecationAgeMs:
          (input.procedureDeprecationAgeDays ?? 30) * 86_400_000,
        maxDeprecationsPerTick: 100,
        voteSignalDecay: 0.95,
      },
      {
        memoryStore,
        linkStore,
        lessonStore,
        procedureStore,
        distillRunner: distill,
        voteStore,
      },
    );
    try {
      const result = await consolidator.runOnce();
      if (result.clustersConsidered === 0) {
        return linkSweep
          ? { kind: "no_clusters", linkSweep }
          : { kind: "no_clusters" };
      }
      return linkSweep
        ? { kind: "ok", result, linkSweep }
        : { kind: "ok", result };
    } finally {
      consolidator.stop();
    }
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : String(err),
      ...(linkSweep ? { linkSweep } : {}),
    };
  } finally {
    procedureStore.close();
    lessonStore.close();
    // VoteStore + LinkStore share the underlying handle owned by
    // memoryStore — closing memoryStore tears down the connection
    // last so every other store's prepared statements stay valid
    // until then.
    memoryStore.close();
  }
}

export interface LinkSweepDeps {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  llamaClient: LlamaServerClient;
  chunkSize: number;
  timeoutMs: number;
}

/**
 * Hydrate every unconsolidated memory and feed it in chunks to the
 * production `LinkGeneratorRunner`. Awaited (unlike the runtime's
 * fire-and-forget) so the consolidator sees the resulting edges
 * immediately. The runner is fire-safe, so per-chunk failures are
 * absorbed silently and we keep going.
 */
export async function runLinkSweep(deps: LinkSweepDeps): Promise<LinkSweepStats> {
  const entries = deps.memoryStore.list({
    scope: "all",
    excludeArchived: true,
  });
  if (entries.length < 2) {
    return { totalCandidates: entries.length, chunks: 0, linksWritten: 0 };
  }
  // Force `cachePrompt: false` for the sweep so a previous slot
  // KV that ended in NONE cannot bias the current generation. The
  // production runtime relies on cache_prompt=true for warmth, but
  // this eval-only batch path runs against a clean DB and a cold
  // sweep — there is no warmth to preserve, and cache hits have
  // been observed to make Gemma-4 stick to the previous slot's
  // output (NONE) even when the current prompt is imperative.
  // See `_debug-link-raw.ts` (cachePrompt=false → 5/5 trials emit
  // LINK lines) vs `_debug-link-sweep.ts` (cachePrompt=true → 0/5).
  // The `LinkGeneratorLlmComplete` type includes a `signal` field
  // that `LlamaServerClient.complete` currently ignores (a known
  // gap — `controller.abort()` doesn't actually cancel the HTTP
  // call). We strip it explicitly here so the type aligns and the
  // request payload stays clean.
  const llmCompleteUncached = async (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
    signal: AbortSignal;
  }) => {
    const { signal: _unused, ...rest } = params;
    void _unused;
    return deps.llamaClient.complete({ ...rest, cachePrompt: false });
  };
  const runner = createLinkGeneratorRunner({
    llmComplete: llmCompleteUncached,
    linkStore: deps.linkStore,
    reflectionSlotId: -1,
    timeoutMs: deps.timeoutMs,
    minCandidates: 2,
    // Minimal stderr logger so the eval operator sees the
    // `link_generator.{ok|none|skipped|timeout|failed}` outcome for
    // each chunk. Without this the sweep is a silent black box and
    // we cannot tell whether the model is rejecting the prompt, the
    // parser is dropping malformed output, or we just need to bump
    // the chunk timeout.
    logger: new StructuredLogger({ level: "debug", sinks: [stderrSink()] }),
  });
  const sessionId = "eval-link-sweep";
  let chunks = 0;
  let linksWritten = 0;
  for (let i = 0; i < entries.length; i += deps.chunkSize) {
    const chunk = entries.slice(i, i + deps.chunkSize);
    if (chunk.length < 2) continue;
    chunks += 1;
    // The link-generator prompt takes `userMessage`/`assistantReply`
    // as topical grounding (see `link-generator-prompt.ts`). In the
    // batch sweep we don't have a real turn pair — we want the LLM
    // to find connections *between candidates themselves*. Phrasing
    // matters significantly here: small instruct models (Gemma-4
    // E4B in particular) default to `NONE` under vague review-style
    // prompts even when notes are obviously related. An imperative
    // wording — "compare every pair, emit LINK for pairs that share
    // a recipe, do not output NONE" — flips the first-token bias
    // and produces 3–4 LINK edges per chunk. Pinned by the
    // `_debug-link-raw.ts` probe: v2 (review-style) → NONE,
    // v4 (imperative) → 4 LINK lines, same model, same candidates.
    linksWritten += await runner.generate({
      sessionId,
      userMessage:
        "Compare every pair of notes. For each pair that shares a remediation recipe (e.g. both add a vendor path to .eslintignore), emit LINK <a> <b> [kind=RELATES_TO]. Do not output NONE — at least three pairs are obviously connected.",
      assistantReply: "(internal batch pass)",
      candidates: chunk.map((e) => ({ id: e.id, body: e.content })),
    });
  }
  return { totalCandidates: entries.length, chunks, linksWritten };
}
