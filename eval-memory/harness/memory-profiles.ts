import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  type UserConfigFile,
} from "../../src/config/config-schema.js";

/**
 * Memory eval profile selector. Determines which v2 features are
 * enabled in the spawned agent's `<stateDir>/config.json`.
 *
 *  - `off` — v1 memory baseline. All v2 phases disabled. This is
 *    **not** "no memory" — profile_facts + FTS5 notes + reflection
 *    still run. The comparison is "v1 only" vs "v1 + everything v2
 *    adds".
 *  - `on`  — all phases 1A–5 enabled at production-ready defaults.
 *    Eviction utility-weighted, dedup on, embeddings on (requires
 *    daemon), links on, evolution on, lessons + consolidation on.
 *
 * Use `seedConfigJson(stateDir, profile, llamaUrl)` to write the
 * resulting `config.json`. The resulting file shape matches
 * `UserConfigFile` (v15+) so `ensureUserConfigFileSync` does not
 * trigger a migration warning at first agent boot.
 */
export type MemoryProfile = "on" | "off";

export interface SeedConfigOptions {
  /** Base llama URL (e.g. `http://127.0.0.1:18991`). Required. */
  llamaUrl: string;
  /**
   * Override `agent.maxSteps`. Default is `USER_CONFIG_DEFAULTS.agent.maxSteps`
   * but multi-turn memory scenarios benefit from a higher cap because each
   * turn legitimately spends several steps.
   */
  maxSteps?: number;
  /**
   * Override `localModels.embeddings.{enabled,modelId}`. Defaults to
   * `enabled: profile === "on"` and the catalog default model. Set
   * `{enabled: false}` explicitly to disable embeddings on the ON
   * profile (useful for E1's BM25-only sub-experiment).
   */
  embeddings?: { enabled: boolean; modelId?: string };
  /**
   * Phase 7b override. The "on" profile leaves
   * `memory.procedures.enabled` at the production default (`false`)
   * so the E2E-2 path matches the out-of-the-box agent. Scenarios
   * that exercise the procedure surface (E2E-3, E6, E8) set this to
   * `true` explicitly. When omitted, the underlying config schema
   * default applies.
   */
  proceduresEnabled?: boolean;
  /**
   * Phase 7a override. The production default is
   * `memory.voting.enabled=false` (ship-dark — adds an extra LLM
   * sub-call to the reflection pipeline). E2E-5 exercises the vote
   * surface and must flip this on; other scenarios leave it off.
   */
  votingEnabled?: boolean;
  /**
   * v2.5 Phase A override (`memory.retrieve.rewriter.enabled`).
   * Default `false`. E9 / E12 flip this on. When set, the recall
   * provider chain wraps the inner provider with the
   * rewriter-aware decorator (see `src/memory/retrieve/`).
   */
  rewriterEnabled?: boolean;
  /**
   * v2.5 Phase B override (`memory.reflection.segmentation.enabled`).
   * Default `false`. E10 / E12 flip this on. When set, reflection
   * fires every `triggerEveryTurns` user turns (default 3) and on
   * `finish` as a final flush.
   */
  segmentationEnabled?: boolean;
  /**
   * v2.5 Phase C override (`memory.reflection.typedNotes.enabled`).
   * Default `false`. E11 / E12 flip this on. When set, reflection
   * uses the typed-NOTE stable prefix + grammar variant that
   * encodes `event` / `behavior` / `knowledge` / `skill` markers
   * in `memories.tags`.
   */
  typedNotesEnabled?: boolean;
  /**
   * Override `log.level`. v2.5 scenarios that count reflection fires
   * from stderr need `"debug"` (the runner logs `reflection.fired`
   * at debug level). Defaults to the user-config default (`"info"`).
   */
  logLevel?: "debug" | "info" | "warn" | "error";
}

export function buildMemoryConfig(
  profile: MemoryProfile,
  opts: SeedConfigOptions,
): UserConfigFile {
  const base = USER_CONFIG_DEFAULTS;
  const embeddingsEnabled = opts.embeddings?.enabled ?? profile === "on";
  // Default embedding model for eval campaigns is `bge-base-en-v1.5` —
  // matches the on-disk GGUF + the PROFILE_PROMPT_BUDGETS_MS comment
  // ("calibrated against ... bge-base-en-v1.5 stack"). Product
  // `USER_CONFIG_DEFAULTS.localModels.embeddings.modelId` is `null`
  // because production users pick their own; eval needs a working
  // default so the second daemon actually starts and hybrid recall
  // is exercised end-to-end.
  const embeddingModelId =
    opts.embeddings?.modelId ??
    base.localModels.embeddings?.modelId ??
    (embeddingsEnabled ? "bge-base-en-v1.5" : null);

  // Start from the defaults, then apply the profile delta.
  const config: UserConfigFile = JSON.parse(JSON.stringify(base));
  config.version = USER_CONFIG_VERSION;

  // llama / model wiring is the same for both profiles — what differs is
  // memory feature flags, not the backing server.
  config.localModels = {
    ...config.localModels,
    url: opts.llamaUrl,
    embeddings: {
      ...config.localModels.embeddings,
      enabled: embeddingsEnabled,
      ...(embeddingModelId ? { modelId: embeddingModelId } : {}),
    },
  };

  config.agent = {
    ...config.agent,
    approvalRequired: false,
    maxSteps: opts.maxSteps ?? config.agent.maxSteps,
  };

  config.tracing = {
    ...config.tracing,
    trace: {
      ...config.tracing.trace,
      enabled: true,
      // Eval-only override. Production default is 10 MiB which is
      // about ~55 turns on a reflection-heavy `full_v2` profile —
      // enough for interactive use but not for LoCoMo / LongMemEval
      // runs that feed 30+ session prefills then ask 100+ questions.
      // When the cap is hit, `trace_truncated` fires and further
      // events are silently dropped (see AGENTS.md §"Traceability and
      // replay"). The harness reads `assistantReply` out of the trace,
      // so post-truncation turns surface as `""` even when the agent
      // really did reply on stdout — see `multi-turn-driver.ts`'s
      // truncation-fallback for the read-side guard. Bumped here to
      // 200 MiB so a full conv-44 (158 QA × 28 sessions ≈ 35 MiB of
      // trace at full fidelity) leaves comfortable head-room.
      // Pinned only by the eval surface — product code is unaffected.
      maxBytesPerSession: 200 * 1024 * 1024,
    },
  };

  if (opts.logLevel) {
    config.log = { ...config.log, level: opts.logLevel };
  }

  // Memory flag deltas — single source of truth for ON vs OFF.
  if (profile === "off") {
    config.memory = {
      ...config.memory,
      eviction: {
        ...config.memory.eviction,
        utilityWeighted: false,
      },
      dedup: {
        ...config.memory.dedup,
        enabled: false,
      },
      embeddings: {
        ...config.memory.embeddings,
        enabled: false,
      },
      links: {
        ...config.memory.links,
        enabled: false,
        autoGenerate: false,
      },
      evolution: {
        ...config.memory.evolution,
        enabled: false,
      },
      lessons: {
        ...config.memory.lessons,
        enabled: false,
      },
      consolidation: {
        ...config.memory.consolidation,
        enabled: false,
      },
    };
    return config;
  }

  // ON profile — everything v2 turned on at production defaults.
  config.memory = {
    ...config.memory,
    eviction: {
      ...config.memory.eviction,
      utilityWeighted: true,
    },
    dedup: {
      ...config.memory.dedup,
      enabled: true,
    },
    embeddings: {
      ...config.memory.embeddings,
      enabled: embeddingsEnabled,
    },
    links: {
      ...config.memory.links,
      enabled: true,
      autoGenerate: true,
    },
    evolution: {
      ...config.memory.evolution,
      enabled: true,
    },
    lessons: {
      ...config.memory.lessons,
      enabled: true,
    },
    consolidation: {
      ...config.memory.consolidation,
      enabled: true,
      // Eval-only overrides on the "on" profile. Production defaults
      // (intervalMs=6h, cooldownMs=24h, minClusterSize=3) are tuned
      // for long-lived user sessions where memories accumulate over
      // days. LoCoMo / LongMemEval runs are 30-90 min total — the
      // production cadence guarantees `lessons=0` because the
      // consolidator never tick'ит within the run window. Lowered
      // here so the cold-path job actually exercises distillation
      // and we can score lesson recall (phase 5 + 6) end-to-end.
      // Pinned only by the eval surface — production agent loop is
      // byte-identical because product code never reads these
      // overrides.
      intervalMs: 300_000, // 5 min — at least 6-12 ticks per conv
      cooldownMs: 1, // schema requires positive int — effectively off
      minClusterSize: 2, // pair-up clusters are valid for short runs
      requireSharedTag: false,
    },
    // Phase 7b is OFF by default in the ON profile too — the
    // production default is `procedures.enabled=false` and the
    // descriptor catalog is now filtered to match (see
    // `filter-disabled-tools.ts`), so the agent stops trying to
    // call `memory.procedures.recall`. Scenarios that need the
    // procedure surface (E6, E8, E2E-3) set their own override via
    // `proceduresEnabled` on `SeedConfigOptions`.
    ...(opts.proceduresEnabled !== undefined
      ? {
          procedures: {
            ...config.memory.procedures,
            enabled: opts.proceduresEnabled,
          },
        }
      : {}),
    ...(opts.votingEnabled !== undefined
      ? {
          voting: {
            ...config.memory.voting,
            enabled: opts.votingEnabled,
          },
        }
      : {}),
    ...(opts.rewriterEnabled !== undefined
      ? {
          retrieve: {
            ...config.memory.retrieve,
            rewriter: {
              ...config.memory.retrieve.rewriter,
              enabled: opts.rewriterEnabled,
            },
          },
        }
      : {}),
    // Eval-only reflection overrides on the "on" profile:
    //  - `timeoutMs` bumped from product default 10s → 60s. Prefill
    //    sessions in LoCoMo dump 4-5k-char transcripts into the
    //    reflection prompt; on the slow qwen-3.6-35b stack the LLM
    //    call routinely exceeds 10s and the runner aborts before
    //    `finish()` writes anything to disk.
    //  - `maxNotesPerCall` bumped from 2 → 5. Diagnostics on a
    //    Caroline prefill turn showed the model emit 5 NOTE lines,
    //    only 2 of which were stored (cap dropped the other 3).
    //  - `anySpeaker: true` switches reflection to the multi-party
    //    prefix. Probe runs (8/8 NONE → 7/7 SET+NOTE) proved that
    //    the production user-centric prompt rejects third-party
    //    dialog in the USER channel — exactly the shape of LoCoMo
    //    / LongMemEval prefill turns. With this flag the extractor
    //    treats every named speaker as a valid source.
    //    These caps stay in product defaults because they are
    //    legitimate guardrails against pathological reflection
    //    output in interactive use; eval intentionally widens them
    //    to measure the reflection pipeline at full fidelity.
    reflection: {
      ...config.memory.reflection,
      timeoutMs: 60_000,
      maxNotesPerCall: 5,
      anySpeaker: true,
      ...(opts.segmentationEnabled !== undefined
        ? {
            segmentation: {
              ...config.memory.reflection.segmentation,
              enabled: opts.segmentationEnabled,
            },
          }
        : {}),
      ...(opts.typedNotesEnabled !== undefined
        ? {
            typedNotes: {
              ...config.memory.reflection.typedNotes,
              enabled: opts.typedNotesEnabled,
            },
          }
        : {}),
    },
  };
  return config;
}

/**
 * Materialise the chosen profile into `<stateDir>/config.json`.
 * Idempotent — overwrites whatever was there.
 */
export function seedConfigJson(
  stateDir: string,
  profile: MemoryProfile,
  opts: SeedConfigOptions,
): UserConfigFile {
  const config = buildMemoryConfig(profile, opts);
  const path = join(stateDir, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return config;
}
