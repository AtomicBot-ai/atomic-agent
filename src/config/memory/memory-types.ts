export type RewriterGateMode = "heuristic" | "embedding" | "always";

/**
 * Cross-session memory fabric. The profile store is a durable SQLite
 * key/value table rendered into the prompt tail on every turn. The
 * reflection layer runs at the end of every turn (fire-and-forget) to
 * distil durable facts out of the last exchange and write them back
 * into the profile store. The notes store is a separate FTS5-backed
 * table that the agent reads/writes explicitly via dedicated tools —
 * it never touches the prompt on its own, so growing the notes corpus
 * does not invalidate the KV-cached stable prefix.
 */
export interface RuntimeMemoryConfig {
  profile: {
    enabled: boolean;
    /** Safety-net ceiling for the rendered `### profile` section. */
    maxTokens: number;
    /**
     * Master switch for the contextual-keyword gate applied by
     * `profile-renderer`. When `true` (default), facts stored with
     * `pinned=false` render into `### profile` only when one of
     * their `keywords` hits the current user message. Flip to
     * `false` to force every fact to render regardless of gating
     * (pre-v3 behaviour) — useful for debugging and for callers
     * that have no user message to key off.
     */
    contextualKeywordGate: boolean;
    /**
     * Cap on active **unpinned** profile facts (issue #407). A write
     * that pushes past it evicts the lowest-utility unpinned facts
     * (`vote_score`, then age, then id) in the same transaction.
     * Pinned facts are never counted and never evicted.
     */
    maxEntries: number;
  };
  reflection: {
    enabled: boolean;
    /** Hard timeout per reflection call (ms). */
    timeoutMs: number;
    /** Upper bound on profile facts written per reflection. */
    maxFactsPerCall: number;
    /**
     * Master switch for the NOTE extraction channel. When `false`,
     * the reflection runner still honours SET facts but drops every
     * NOTE line even if `memoryStore` is wired — useful for rolling
     * out the new behaviour gradually or disabling it if MemoryStore
     * growth becomes a concern.
     */
    autoStoreNotes: boolean;
    /**
     * Upper bound on freeform notes written per reflection call.
     * Mirrors `maxFactsPerCall` for the MemoryStore channel. `0`
     * disables note extraction even when `autoStoreNotes` is true.
     */
    maxNotesPerCall: number;
    /** v2.5 typed-NOTE extraction. See UserConfigFile.memory.reflection.typedNotes. */
    typedNotes: {
      enabled: boolean;
    };
    /** v2.5 sliding-window reflection segmentation. See UserConfigFile.memory.reflection.segmentation. */
    segmentation: {
      enabled: boolean;
      triggerEveryTurns: number;
      windowTurns: number;
    };
    /**
     * Multi-party reflection mode (config v19+). See
     * UserConfigFile.memory.reflection.anySpeaker for rationale.
     * When `true`, the reflection prompt switches to a prefix
     * that treats every speaker in the USER channel as a source
     * worth extracting (e.g. third-party dialog dumps from
     * LoCoMo / LongMemEval benchmarks). Default `false`.
     */
    anySpeaker: boolean;
  };
  notes: {
    enabled: boolean;
    /** Hard cap on stored memory rows. Oldest rows are evicted on overflow. */
    maxEntries: number;
    /** Per-call input ceiling for `memory.notes.store.content`. */
    maxContentChars: number;
    /** Default `k` when `memory.notes.recall` omits it. */
    recallDefaultK: number;
  };
  /**
   * Pre-step recall injection: each turn, the agent-loop can pre-fetch
   * the top-K notes most relevant to the user message and render them
   * as `### recalled` in the prompt tail. `k=0` or `enabled=false`
   * disables the section entirely.
   *
   * Kept strictly in the variable tail (never the stable prefix) so
   * the KV cache of the persona/tools/skills slab stays intact across
   * turns with different recalled sets.
   */
  recallInjection: {
    enabled: boolean;
    /** Top-K notes to include. Applied after BM25 ranking. */
    k: number;
    /** Per-line preview clip length (chars) in the `### recalled` block. */
    previewChars: number;
    /** Safety-net ceiling for the rendered `### recalled` section. */
    maxTokens: number;
  };
  /**
   * Memory index: compact `#id tags preview` pointers rendered as the
   * `### memory-index` section. Lets the agent know *what notes exist*
   * without paying the full body cost — drilling in is via
   * `memory.notes.recall { id }`.
   */
  index: {
    enabled: boolean;
    /** How many most-recent note pointers to advertise. */
    limit: number;
    /** Per-line preview clip length (chars). */
    previewChars: number;
    /** Safety-net ceiling for the rendered `### memory-index` section. */
    maxTokens: number;
  };
  /** Phase 1A: pre-insert near-match deduplication. See UserConfigFile.memory.dedup. */
  dedup: {
    enabled: boolean;
    fts5Threshold: number;
  };
  /** Phase 1A: utility-weighted overflow eviction. See UserConfigFile.memory.eviction. */
  eviction: {
    utilityWeighted: boolean;
    maxAgeMs: number;
  };
  /**
   * Phase 1B: hybrid FTS5 + cosine recall. See
   * UserConfigFile.memory.embeddings. Default **disabled** — the
   * runtime only attempts to talk to the embedding daemon when this
   * flag flips on AND a model is configured AND the daemon is
   * reachable.
   */
  embeddings: {
    enabled: boolean;
    fts5Weight: number;
    vectorWeight: number;
    bruteForceCeiling: number;
  };
  /**
   * Phase 2: reactive link graph. See UserConfigFile.memory.links.
   * Enabled by default. With the master switch off the
   * link-generator LLM sub-call never fires and recall-side
   * expansion is skipped.
   */
  links: {
    enabled: boolean;
    autoGenerate: boolean;
    expansionDepth: number;
    maxExpanded: number;
    maxLinksPerCall: number;
    minCandidates: number;
    generatorTimeoutMs: number;
  };
  /**
   * Phase 3: memory evolution (neighbor-evolver). Enabled by
   * default. With the master switch off the parser still
   * recognises `EVOLVE` lines but silently drops them. See
   * UserConfigFile.memory.evolution.
   */
  evolution: {
    enabled: boolean;
    maxPerWrite: number;
    leaseMs: number;
  };
  /**
   * Phase 5: distilled lessons + cold-path consolidator. See
   * UserConfigFile.memory.lessons for full doc. Enabled by
   * default; with the master switch off, `### lessons` is not rendered,
   * `memory.lessons.recall` returns `LessonsDisabledError`, and
   * the consolidator never registers its periodic timer.
   */
  lessons: {
    enabled: boolean;
    recallK: number;
    maxTokens: number;
    indexLimit: number;
    maxEntries: number;
    deprecationAgeMs: number;
  };
  /**
   * Phase 7b: MemP-style advisory procedures distilled alongside
   * lessons. Enabled by default; when off, the `### procedures`
   * section is not rendered, `memory.procedures.recall` returns a
   * `ProceduresDisabledError`, and the consolidator emits only the
   * `LESSON` half of the combined grammar.
   */
  procedures: {
    enabled: boolean;
    recallK: number;
    maxTokens: number;
    indexLimit: number;
    maxEntries: number;
    deprecationAgeMs: number;
  };
  consolidation: {
    enabled: boolean;
    intervalMs: number;
    cooldownMs: number;
    minClusterSize: number;
    maxClustersPerTick: number;
    requireSharedTag: boolean;
    distillTimeoutMs: number;
  };
  /**
   * Phase 7a: ExpeL-style vote curation. The reflection slot grows
   * one extra sub-call per turn (after link-generator and
   * neighbor-evolver) that asks the model to UPVOTE/DOWNVOTE the
   * items surfaced in this turn's variable tail. See
   * `UserConfigFile.memory.voting` for full doc. Enabled by
   * default; the extra LLM call rides the shared reflection slot,
   * so turning it off removes one sub-call per turn.
   */
  voting: {
    enabled: boolean;
    maxVotePerItem: number;
    signalDecay: number;
    scoreBlend: number;
    eventLogMaxRows: number;
    profileFilterThreshold: number;
  };
  /**
   * v2.5 heuristic-gated query rewriter for recall. See
   * UserConfigFile.memory.retrieve.rewriter for full doc. Default
   * disabled — the provider chain is byte-identical to pre-v18
   * behaviour when off.
   */
  retrieve: {
    rewriter: {
      enabled: boolean;
      timeoutMs: number;
      historyTurns: number;
      gateMode: RewriterGateMode;
      embeddingGate: {
        threshold: number;
        exemplars: string[] | null;
      };
    };
  };
}

export interface UserMemoryConfig {
  profile: {
    enabled: boolean;
    maxTokens: number;
    contextualKeywordGate: boolean;
    /** Cap on active unpinned facts. See the runtime type above. */
    maxEntries: number;
  };
  reflection: {
    enabled: boolean;
    timeoutMs: number;
    maxFactsPerCall: number;
    autoStoreNotes: boolean;
    maxNotesPerCall: number;
    /**
     * v2.5 (config v18). Typed-NOTE extraction:
     * when `enabled`, the reflection prompt forces every NOTE to
     * carry a `[type=event|behavior|knowledge|skill]` marker that
     * the parser projects into a synthetic `type:X` tag on the
     * stored memory. Default `false` — legacy untyped NOTEs are
     * byte-stable. Flipping the flag invalidates the reflection
     * slot's KV cache once on the next call (the main agent slot
     * is unaffected).
     */
    typedNotes: {
      enabled: boolean;
    };
    /**
     * v2.5 (config v18). Sliding-window
     * reflection segmentation: instead of firing reflection after
     * every turn with only the last user/assistant pair, accumulate
     * up to `windowTurns` exchanges and fire reflection once every
     * `triggerEveryTurns` turns. Reflection still fires
     * unconditionally on `reason: "finish"` so the trailing partial
     * window is never lost. Default `enabled = false` preserves the
     * per-turn behaviour exactly.
     */
    /**
     * Multi-party / "any-speaker" reflection mode (config v19+).
     * When `true`, the reflection prompt switches to
     * `REFLECTION_STABLE_PREFIX_ANY_SPEAKER` so the extractor
     * treats every named speaker in the USER channel — including
     * third parties — as a valid source for SET / NOTE
     * extraction. Designed for evaluation benchmarks (LoCoMo,
     * LongMemEval) where the USER message is a dump of a
     * multi-party dialog rather than the user's own statements.
     *
     * Default `false`. Production personal-assistant users keep
     * the user-centric prefix that rejects "content not stated
     * by the user". Flipping the flag invalidates the reflection
     * slot's KV cache once on the next call; the main agent slot
     * is unaffected. Wins over `typedNotes` because the
     * any-speaker prefix already enforces typed NOTEs.
     */
    anySpeaker: boolean;
    segmentation: {
      enabled: boolean;
      /**
       * Trigger reflection every N turns. Must be a positive
       * integer; `1` is functionally equivalent to disabled mode
       * (reflection fires every turn).
       */
      triggerEveryTurns: number;
      /**
       * Number of trailing user/assistant pairs to feed into the
       * reflection prompt. Bounded by `triggerEveryTurns` from
       * below — the runtime clamps the slice to whatever is
       * available so an early-session turn never blows past the
       * existing transcript.
       */
      windowTurns: number;
    };
  };
  notes: {
    enabled: boolean;
    maxEntries: number;
    maxContentChars: number;
    recallDefaultK: number;
  };
  recallInjection: {
    enabled: boolean;
    k: number;
    previewChars: number;
    maxTokens: number;
  };
  index: {
    enabled: boolean;
    limit: number;
    previewChars: number;
    maxTokens: number;
  };
  /**
   * Memory-v2 phase 1A: opt-in pre-insert dedup. Added in config v11;
   * older files transparently upgraded with the defaults below.
   */
  dedup: {
    enabled: boolean;
    fts5Threshold: number;
  };
  /**
   * Memory-v2 phase 1A: utility-weighted overflow eviction. Added in
   * config v11.
   */
  eviction: {
    utilityWeighted: boolean;
    maxAgeMs: number;
  };
  /**
   * Memory-v2 phase 1B: hybrid FTS5 + embedding recall. Added in
   * config v12. Default **disabled** — the runtime won't try to
   * embed anything until this flips on and a second daemon is
   * available.
   */
  embeddings: {
    enabled: boolean;
    fts5Weight: number;
    vectorWeight: number;
    bruteForceCeiling: number;
  };
  /**
   * Memory-v2 phase 2: reactive link graph. Added in config v13.
   * Default **enabled** — the link-generator reflection sub-call
   * (an extra LLM round-trip on the reflection slot at end of
   * turn) is gated on `enabled` and `autoGenerate`; recall-side
   * BFS expansion is gated on `enabled` as well.
   *
   *  - `enabled`            master switch (covers both recall
   *                         expansion and link generation).
   *  - `autoGenerate`       fire the `link-generator` sub-call
   *                         after main reflection. Set to `false`
   *                         to keep the schema + expansion
   *                         machinery but never grow the graph
   *                         automatically (manual `LinkStore.add`
   *                         still works).
   *  - `expansionDepth`     BFS depth on recall. Clamped to [1, 3].
   *  - `maxExpanded`        Hard cap on expanded-id count per
   *                         recall turn.
   *  - `maxLinksPerCall`    Hard cap on persisted edges per
   *                         link-generator call.
   *  - `minCandidates`      Skip the LLM call when the surfaced
   *                         set has fewer than this many ids
   *                         (zero useful links possible).
   *  - `generatorTimeoutMs` Hard timeout for the LLM call.
   */
  links: {
    enabled: boolean;
    autoGenerate: boolean;
    expansionDepth: number;
    maxExpanded: number;
    maxLinksPerCall: number;
    minCandidates: number;
    generatorTimeoutMs: number;
  };
  /**
   * Memory-v2 phase 3: neighbor-evolver. Added in config v14.
   * Default **enabled** — reflection can refine `tags` on existing
   * memories. When off, the parser still recognises `EVOLVE` lines
   * but the runner drops them silently.
   *
   *  - `enabled`     master switch. Default `true`.
   *  - `maxPerWrite` Hard cap on number of EVOLVE directives
   *                  actually applied per reflection. Default `2`.
   *  - `leaseMs`     B↔C lease window in ms. EVOLVE skips any
   *                  target whose `consolidating_at` lies within
   *                  `now - leaseMs`. Default `60000` (1 min).
   */
  evolution: {
    enabled: boolean;
    maxPerWrite: number;
    leaseMs: number;
  };
  /**
   * Memory-v2 phase 5. Distilled lessons + cold-path consolidator.
   * Enabled by default. Rolling phase 5 on flipped the stable
   * prefix bytes once (see ../../memory/docs/retrieval.md);
   * that upgrade has shipped, so the switch is now on out of the
   * box and turning it off is the deliberate act.
   *
   * `lessons` keys:
   *   - `enabled`            master switch for `### lessons`
   *                          rendering + `memory.lessons.recall` +
   *                          `ConsolidatorJob.start`. Default
   *                          `true`.
   *   - `recallK`            top-K lessons surfaced per turn (BM25).
   *                          Default `2`.
   *   - `maxTokens`          hard cap on the rendered `### lessons`
   *                          block. Default `300`.
   *   - `indexLimit`         row cap on `LessonStore.listIndex`.
   *                          Default `20`.
   *   - `maxEntries`         hard cap on active lessons. Default
   *                          `500`. Phase 6 owns the deprecation
   *                          sweep — phase 5 plumbs it dormant.
   *   - `deprecationAgeMs`   phase 6 hook (still wired in phase 5):
   *                          lessons with `success_count == 0`
   *                          older than this become deprecated.
   *                          Default `2_592_000_000` (30 days).
   *
   * `consolidation` keys:
   *   - `enabled`              master switch on the consolidator
   *                            timer. Default `true`. Independent
   *                            from `lessons.enabled` so the schema
   *                            can be inspected without ticking.
   *   - `intervalMs`           consolidator tick period. Default
   *                            `21_600_000` (6 h).
   *   - `cooldownMs`           episodes younger than this are
   *                            ineligible (must "cool down" before
   *                            distillation). Default `86_400_000`
   *                            (24 h).
   *   - `minClusterSize`       minimum cluster size to distill.
   *                            Default `3`.
   *   - `maxClustersPerTick`   throughput cap on a single tick.
   *                            Default `5`.
   *   - `requireSharedTag`     when `true`, every member of a CC
   *                            must share at least one tag with
   *                            every other member. Default `true`
   *                            for semantic cohesion.
   *   - `distillTimeoutMs`     per-cluster LLM timeout. Default
   *                            `45_000` ms.
   */
  lessons: {
    enabled: boolean;
    recallK: number;
    maxTokens: number;
    indexLimit: number;
    maxEntries: number;
    deprecationAgeMs: number;
  };
  /**
   * Memory-v2 phase 7b. Procedures (MemP-style how-to templates)
   * mirroring `lessons.*`:
   *   - `enabled`           master switch. Default `true`.
   *   - `recallK`           top-K procedures surfaced per turn
   *                         via BM25 against the current user
   *                         message. Default `2`.
   *   - `maxTokens`         hard cap on the rendered `### procedures`
   *                         block. Default `400`.
   *   - `indexLimit`        row cap on `ProcedureStore.listIndex`.
   *                         Default `20`.
   *   - `maxEntries`        hard cap on active procedures. Default
   *                         `500`. Overflow triggers FIFO eviction
   *                         in the consolidator (scenario 7b.F.2).
   *   - `deprecationAgeMs`  procedures with `success_count == 0`
   *                         AND `use_count == 0` older than this
   *                         are deprecated. Default `2_592_000_000`
   *                         (30 days).
   */
  procedures: {
    enabled: boolean;
    recallK: number;
    maxTokens: number;
    indexLimit: number;
    maxEntries: number;
    deprecationAgeMs: number;
  };
  consolidation: {
    enabled: boolean;
    intervalMs: number;
    cooldownMs: number;
    minClusterSize: number;
    maxClustersPerTick: number;
    requireSharedTag: boolean;
    distillTimeoutMs: number;
  };
  /**
   * Memory-v2 phase 7a. Vote curation (ExpeL-style). Adds a vote
   * sub-call to the reflection pipeline that emits UPVOTE /
   * DOWNVOTE markers against items surfaced in the current turn,
   * plus a cold-path decay applied by `ConsolidatorJob`.
   *
   * `voting` keys:
   *   - `enabled`               master switch. When `false` the
   *                              vote sub-call is skipped, decay
   *                              does not run, and the lesson
   *                              recall reranker treats every
   *                              row as if `vote_score = 0`.
   *                              Default `true`.
   *   - `maxVotePerItem`        clamp on `|vote_score|`. Each
   *                              UPVOTE/DOWNVOTE is `+1`/`-1` and
   *                              the row is pinned in
   *                              `[-maxVotePerItem, +maxVotePerItem]`.
   *                              Must be > 0; bootstrap rejects 0.
   *                              Default `50`.
   *   - `signalDecay`           per-tick scaling factor applied
   *                              to every `vote_score` value on
   *                              the consolidator tick. Range
   *                              `(0, 1]`; `1.0` disables decay,
   *                              `0.95` matches the spec default.
   *                              Bootstrap rejects `<= 0` and
   *                              `> 1`. Default `0.95`.
   *   - `scoreBlend`            weight of `vote_score` in
   *                              `combinedScore = scoreBlend *
   *                              vote_score + (1 - scoreBlend) *
   *                              (success_count - failure_count)`.
   *                              Range `[0, 1]`. Default `0.6`.
   *   - `eventLogMaxRows`       FIFO cap on the `vote_events`
   *                              audit log. Default `50_000`;
   *                              `0` disables eviction (the row
   *                              count is then bounded only by
   *                              disk space).
   *   - `profileFilterThreshold` minimum `|vote_score|` at which a
   *                              `profile_facts` row is hidden
   *                              from `### profile`. Negative
   *                              votes ≤ `-profileFilterThreshold`
   *                              mute the fact; positive scores
   *                              never hide a fact. Default `3`.
   */
  voting: {
    enabled: boolean;
    maxVotePerItem: number;
    signalDecay: number;
    scoreBlend: number;
    eventLogMaxRows: number;
    profileFilterThreshold: number;
  };
  /**
   * v2.5 memory fabric additions (config v18). Heuristic-
   * gated query rewriter for recall. The rewriter runs as a
   * decorator wrapped around `createDefaultMemoryContextProvider`:
   * before BM25/cosine recall, if the current user message looks
   * referential (short, pronouns, conjunction-starter), one LLM
   * call rewrites it into a self-contained query using the last
   * few turns of conversation; otherwise the raw message is used
   * as today. The rewriter runs on the side-call slot
   * (`slotManager.sideCallSlotId()`: the reserved reflection slot,
   * or `-1` when only one slot exists), so the **main agent slot**
   * is untouched.
   *
   * `retrieve.rewriter` keys:
   *  - `enabled`       master switch. Default `true`.
   *  - `timeoutMs`     hard per-call timeout. Default `10_000`.
   *  - `historyTurns`  trailing turns fed into the rewriter
   *                    prompt. Default `3`.
   *  - `gateMode`      `heuristic` | `embedding` | `always`.
   *                    Default `heuristic`. Eval profiles often
   *                    use `embedding` for multilingual recall.
   *  - `embeddingGate.threshold` cosine floor when
   *                    `gateMode=embedding`. Default `0.65`.
   *  - `embeddingGate.exemplars` custom EN referential phrases;
   *                    `null` uses built-in defaults.
   */
  retrieve: {
    rewriter: {
      enabled: boolean;
      timeoutMs: number;
      historyTurns: number;
      gateMode: RewriterGateMode;
      embeddingGate: {
        threshold: number;
        exemplars: string[] | null;
      };
    };
  };
}
