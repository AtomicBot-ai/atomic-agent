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
}

export function buildMemoryConfig(
  profile: MemoryProfile,
  opts: SeedConfigOptions,
): UserConfigFile {
  const base = USER_CONFIG_DEFAULTS;
  const embeddingsEnabled = opts.embeddings?.enabled ?? profile === "on";
  const embeddingModelId =
    opts.embeddings?.modelId ?? base.localModels.embeddings?.modelId;

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
    },
  };

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
    },
    // Phase 7b — keep procedures aligned with lessons for the ON
    // profile. The production default is `false`, but evals exercise
    // the full v2 surface: when `procedures.enabled = false`, the
    // `memory.procedures.recall` tool descriptor still ships in the
    // stable prefix (see `default-tool-descriptors-b.ts`) but the
    // tool is **not** registered. The model then tries to call it
    // and the agent loop fails the turn with
    // `tool not registered in this agent: memory.procedures.recall`.
    // Tracked as a separate production-side bug (descriptor must be
    // filtered out of `effectiveToolDescriptors` when the tool is
    // gated off — same shape as the existing `vision.describe`
    // filter in `bootstrap.ts`).
    procedures: {
      ...config.memory.procedures,
      enabled: true,
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
