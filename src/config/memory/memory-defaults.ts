import type { UserMemoryConfig } from "./memory-types.js";

export function createMemoryDefaults(): UserMemoryConfig {
  return {
    profile: {
      enabled: true,
      maxTokens: 512,
      contextualKeywordGate: true,
      // Same order as `memory.lessons.maxEntries`. It counts unpinned
      // facts only, and reflection writes at most three facts a turn, so
      // a fresh install needs hundreds of turns of new keys to get here;
      // the long-running store in issue #407 had 19 unpinned facts.
      // Inert until a store is genuinely large.
      maxEntries: 500,
    },
    reflection: {
      enabled: true,
      timeoutMs: 60_000,
      maxFactsPerCall: 3,
      autoStoreNotes: true,
      maxNotesPerCall: 2,
      typedNotes: {
        // v2.5 (v18). Off by default — flipping it
        // on switches the reflection prompt to the typed prefix and
        // invalidates the reflection slot's KV cache once on the
        // next call. The main agent slot is untouched.
        enabled: false,
      },
      // Multi-party reflection mode (v19). Off by default —
      // production personal-assistant users keep the user-centric
      // prefix. Evaluation benchmarks (LoCoMo, LongMemEval) flip
      // this to true so reflection can extract third-party
      // speakers from prefill conversation transcripts.
      anySpeaker: false,
      segmentation: {
        // v2.5 (v18). Off by default — when on,
        // reflection fires every `triggerEveryTurns` turns over the
        // last `windowTurns` exchanges instead of every turn. The
        // final flush on `reason: "finish"` is unconditional.
        enabled: false,
        triggerEveryTurns: 3,
        windowTurns: 5,
      },
    },
    notes: {
      enabled: true,
      maxEntries: 1_000,
      maxContentChars: 4_000,
      recallDefaultK: 5,
    },
    recallInjection: {
      enabled: true,
      k: 3,
      previewChars: 160,
      maxTokens: 400,
    },
    index: {
      enabled: true,
      limit: 20,
      previewChars: 60,
      maxTokens: 300,
    },
    dedup: {
      enabled: true,
      fts5Threshold: 0.85,
    },
    eviction: {
      utilityWeighted: true,
      // 30 days. Declared here for v2 phase 5 (ConsolidatorJob sweep);
      // phase 1A's overflow eviction does not consult `maxAgeMs`.
      maxAgeMs: 2_592_000_000,
    },
    embeddings: {
      enabled: false,
      // Even split between BM25 and cosine — picked as the safe
      // starting point; once we have telemetry from real corpora a
      // follow-up will tune the ratio. The two MUST sum to ~1.0; the
      // bootstrap pins this invariant in phase 1B onwards.
      fts5Weight: 0.5,
      vectorWeight: 0.5,
      bruteForceCeiling: 200,
    },
    links: {
      // Phase 2 — reactive link graph + recall BFS expansion.
      enabled: true,
      autoGenerate: true,
      expansionDepth: 1,
      maxExpanded: 12,
      maxLinksPerCall: 4,
      minCandidates: 2,
      generatorTimeoutMs: 60_000,
    },
    evolution: {
      // Phase 3 — reflection refines tags on existing memories.
      // `content` remains append-only regardless.
      enabled: true,
      maxPerWrite: 2,
      leaseMs: 60_000,
    },
    lessons: {
      // Phase 5 — adds `### lessons` to the prompt tail (stable-prefix
      // change #1) and registers the consolidator timer when
      // `memory.consolidation.enabled` is also true.
      enabled: true,
      recallK: 2,
      maxTokens: 300,
      indexLimit: 20,
      maxEntries: 500,
      deprecationAgeMs: 2_592_000_000,
    },
    procedures: {
      // Phase 7b — adds `### procedures` to the prompt tail (stable-prefix
      // change #2) and switches the consolidator distill grammar
      // to the combined lesson+procedure shape.
      enabled: true,
      recallK: 2,
      maxTokens: 400,
      indexLimit: 20,
      maxEntries: 500,
      deprecationAgeMs: 2_592_000_000,
    },
    consolidation: {
      // Phase 5 — scoped periodic timer carve-out (like Telegram polling).
      enabled: true,
      intervalMs: 21_600_000,
      cooldownMs: 86_400_000,
      minClusterSize: 3,
      maxClustersPerTick: 5,
      requireSharedTag: true,
      distillTimeoutMs: 45_000,
    },
    voting: {
      // Phase 7a — extra LLM sub-call on the reflection slot + cold-path
      // decay on consolidator ticks.
      enabled: true,
      maxVotePerItem: 50,
      signalDecay: 0.95,
      scoreBlend: 0.6,
      eventLogMaxRows: 50_000,
      profileFilterThreshold: 3,
    },
    retrieve: {
      rewriter: {
        // v2.5 (v18) — heuristic-gated query rewriter before recall.
        // Runs on the side-call slot (`sideCallSlotId()`; `-1` only when
        // there is a single slot) so the main agent slot stays untouched.
        enabled: true,
        timeoutMs: 10_000,
        historyTurns: 3,
        gateMode: "heuristic",
        embeddingGate: {
          threshold: 0.65,
          exemplars: null,
        },
      },
    },
  };
}
