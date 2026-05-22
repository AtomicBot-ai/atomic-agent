/**
 * Seven named campaign memory profiles for the benchmark plan.
 *
 * The existing `harness/memory-profiles.ts` already exposes a
 * fine-grained `buildMemoryConfig(profile, opts)` with many boolean
 * overrides — that surface is intentionally low-level so individual
 * experiments (E1..E12) can carve out exactly what they need.
 *
 * The campaign needs the opposite: a small, **named** set of memory
 * configurations that get compared apples-to-apples across LoCoMo,
 * LongMemEval, the Atomic e1..e12 suite, and the L2 evaluation
 * benchmarks (ALFWorld / SWE-bench Lite). Calling
 * `buildCampaignConfig("hybrid_plus_lessons", {...})` is the **only**
 * way a runner should pick a profile for the campaign; that keeps
 * "what does hybrid mean" pinned in one file instead of scattered
 * across runners.
 *
 * Profiles (matches PLAN.md Phase 1):
 *
 *  - `none` — no memory at all. Profile facts, notes, reflection all
 *    off. The "lobotomised" baseline that exposes how much the agent
 *    relies on memory.
 *  - `fts5_only` — v1 memory: profile facts + FTS5 notes +
 *    reflection. No embeddings, no links, no lessons, no evolution.
 *    Equivalent to the legacy `off` profile.
 *  - `vector_only` — embedding-based recall **without** FTS5 lexical
 *    matching. Useful for the "is hybrid actually adding signal"
 *    ablation. Implemented as FTS5-on (storage layer requires it)
 *    with `fts5Weight: 0` and `vectorWeight: 1` so the ranker only
 *    consumes vector scores.
 *  - `hybrid` — FTS5 + embeddings, balanced weights. The default v2
 *    recall path.
 *  - `hybrid_plus_graph` — hybrid + link graph (BFS expansion on
 *    recall hits).
 *  - `hybrid_plus_lessons` — hybrid + graph + lessons + consolidator.
 *    The full reactive memory stack short of voting / procedures.
 *  - `full_v2` — everything on: lessons, consolidation, voting,
 *    procedures, evolution, dedup, utility-weighted eviction, plus
 *    the three v2.5 additions (rewriter, segmentation, typed notes).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { UserConfigFile } from "../../src/config/config-schema.js";
import {
  buildMemoryConfig,
  type SeedConfigOptions,
} from "../harness/memory-profiles.js";

export const CAMPAIGN_PROFILE_NAMES = [
  "none",
  "fts5_only",
  "vector_only",
  "hybrid",
  "hybrid_plus_graph",
  "hybrid_plus_lessons",
  "full_v2",
] as const;

export type CampaignProfileName = (typeof CAMPAIGN_PROFILE_NAMES)[number];

/**
 * Short human-readable description, used in markdown summary headers
 * and CSV column labels.
 */
export const CAMPAIGN_PROFILE_LABELS: Record<CampaignProfileName, string> = {
  none: "no memory (control)",
  fts5_only: "v1 memory (FTS5 + reflection)",
  vector_only: "embeddings-only recall (FTS5 weight = 0)",
  hybrid: "v2 hybrid recall (FTS5 + embeddings)",
  hybrid_plus_graph: "hybrid + link graph",
  hybrid_plus_lessons: "hybrid + graph + lessons + consolidator",
  full_v2: "full v2 (lessons + voting + procedures + v2.5 additions)",
};

/**
 * Per-profile wall-clock budget per scenario prompt, in milliseconds.
 * Used by long-running benchmark harnesses (LoCoMo, LongMemEval) to
 * size the multi-turn driver's overall `timeoutMs`. The naïve
 * `prompts × 60_000ms` heuristic that the runner used to ship with
 * worked for lightweight profiles but routinely killed `full_v2`
 * mid-prefill because each session reply on full_v2 takes ~120-180s
 * wall-clock (reflection + link-generator + neighbour-evolver +
 * consolidator all share a single reflection slot that serialises
 * with the next main turn).
 *
 * Numbers were calibrated against traces of conv-26 prefill turns
 * on the local qwen-3.6-35b-a3b + bge-base-en-v1.5 stack
 * (`durationMs` per `turn_finished` in `traces/<sessionId>.ndjson`,
 * captured with `ATOMIC_AGENT_LOCOMO_KEEP_STATE=1`). Re-tune when
 * the stack changes; the comment block in PROFILE_PROMPT_BUDGETS_MS
 * is the single source of truth.
 */
export const PROFILE_PROMPT_BUDGETS_MS: Record<CampaignProfileName, number> = {
  // No memory layer: a single inference + reply, ~5-15s typical.
  none: 60_000,
  // BM25-only reflection: synchronous reflection at end of turn,
  // negligible extra work — 30-45s typical.
  fts5_only: 60_000,
  // Vector-only: writes an embedding fire-and-forget; same shape as fts5_only.
  vector_only: 60_000,
  // Hybrid (FTS5 + embedding) without graph/lessons: same shape, slightly
  // heavier recall, ~30-50s typical.
  hybrid: 60_000,
  // Hybrid + link graph: adds link-generator on the reflection slot,
  // ~60-90s typical. 120s budget = ~30% safety margin.
  hybrid_plus_graph: 120_000,
  // Hybrid + graph + lessons + consolidator: full reflection pipeline
  // minus voting/procedures; the consolidator's distill call can take
  // 30+ seconds on its own. ~90-150s typical.
  hybrid_plus_lessons: 180_000,
  // Full v2: reflection + links + evolver + consolidator + voting +
  // procedures + rewriter + segmentation. Observed ~120-210s/session
  // on conv-26 prefill; 180s is the tight budget. Bump if a deeper
  // model with longer tool chains lands.
  full_v2: 180_000,
};

/**
 * Resolve the per-prompt wall-clock budget for a campaign profile.
 * Defaults to 60_000 for unknown profile names (defensive — runners
 * are typed against `CampaignProfileName`, so unknown names should
 * only show up if the catalog drifts under us).
 */
export function getProfilePromptBudgetMs(profile: CampaignProfileName): number {
  return PROFILE_PROMPT_BUDGETS_MS[profile] ?? 60_000;
}

export interface CampaignConfigOptions extends SeedConfigOptions {
  /**
   * Override the campaign-wide procedures flag for `full_v2`. Defaults
   * to `true` for `full_v2` (the whole point of that profile),
   * `undefined` for everything else (uses production defaults).
   */
  proceduresEnabled?: boolean;
  /**
   * Same as above but for the voting sub-call. Defaults to `true` on
   * `full_v2`, unset on every other profile.
   */
  votingEnabled?: boolean;
}

type ConfigMutator = (config: UserConfigFile) => UserConfigFile;

function pipe(config: UserConfigFile, ...mutators: ConfigMutator[]): UserConfigFile {
  return mutators.reduce<UserConfigFile>((acc, fn) => fn(acc), config);
}

/**
 * Build the `UserConfigFile` for the named campaign profile. Throws
 * for an unknown name (defensive — runners are expected to use the
 * `CampaignProfileName` type, this is just belt-and-braces).
 */
export function buildCampaignConfig(
  profile: CampaignProfileName,
  opts: CampaignConfigOptions,
): UserConfigFile {
  switch (profile) {
    case "none":
      return applyNone(
        buildMemoryConfig("off", { ...opts, embeddings: { enabled: false } }),
      );
    case "fts5_only":
      return buildMemoryConfig("off", { ...opts, embeddings: { enabled: false } });
    case "vector_only":
      return applyVectorOnly(
        buildMemoryConfig("on", { ...opts, embeddings: { enabled: true } }),
      );
    case "hybrid":
      return pipe(
        buildMemoryConfig("on", { ...opts, embeddings: { enabled: true } }),
        disableLinks,
        disableEvolution,
        disableLessons,
        disableConsolidation,
      );
    case "hybrid_plus_graph":
      return pipe(
        buildMemoryConfig("on", { ...opts, embeddings: { enabled: true } }),
        disableEvolution,
        disableLessons,
        disableConsolidation,
      );
    case "hybrid_plus_lessons":
      return buildMemoryConfig("on", {
        ...opts,
        embeddings: { enabled: true },
      });
    case "full_v2":
      return buildMemoryConfig("on", {
        ...opts,
        embeddings: { enabled: true },
        proceduresEnabled: opts.proceduresEnabled ?? true,
        votingEnabled: opts.votingEnabled ?? true,
        rewriterEnabled: opts.rewriterEnabled ?? true,
        segmentationEnabled: opts.segmentationEnabled ?? true,
        typedNotesEnabled: opts.typedNotesEnabled ?? true,
      });
  }
}

/** Materialise the chosen campaign profile into `<stateDir>/config.json`. */
export function seedCampaignConfigJson(
  stateDir: string,
  profile: CampaignProfileName,
  opts: CampaignConfigOptions,
): UserConfigFile {
  const config = buildCampaignConfig(profile, opts);
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
  return config;
}

// ---------------------------------------------------------------------------
// Profile-specific post-processors. Kept tiny so the campaign layer
// stays a thin wrapper over the harness-level builder.
// ---------------------------------------------------------------------------

/**
 * The `none` profile turns off every memory write/read surface: no
 * profile facts, no notes, no reflection, no embeddings. The agent
 * runs lobotomised — every turn starts from scratch. This is the
 * baseline that lets us claim "memory does N% lift".
 */
function applyNone(config: UserConfigFile): UserConfigFile {
  const next: UserConfigFile = JSON.parse(JSON.stringify(config));
  next.memory = {
    ...next.memory,
    profile: { ...next.memory.profile, enabled: false },
    notes: { ...next.memory.notes, enabled: false },
    reflection: { ...next.memory.reflection, enabled: false },
    recallInjection: { ...next.memory.recallInjection, enabled: false },
    index: { ...next.memory.index, enabled: false },
    embeddings: { ...next.memory.embeddings, enabled: false },
    links: { ...next.memory.links, enabled: false, autoGenerate: false },
    evolution: { ...next.memory.evolution, enabled: false },
    lessons: { ...next.memory.lessons, enabled: false },
    consolidation: { ...next.memory.consolidation, enabled: false },
  };
  return next;
}

/**
 * Vector-only ablation: FTS5 storage stays on (the schema can't drop
 * it without an invasive migration) but recall scoring drops the
 * lexical channel by zeroing `fts5Weight` and pinning `vectorWeight`
 * to 1.
 */
function applyVectorOnly(config: UserConfigFile): UserConfigFile {
  const next: UserConfigFile = JSON.parse(JSON.stringify(config));
  next.memory = {
    ...next.memory,
    embeddings: {
      ...next.memory.embeddings,
      enabled: true,
      fts5Weight: 0,
      vectorWeight: 1,
    },
  };
  return next;
}

const disableLinks: ConfigMutator = (config) => {
  const next: UserConfigFile = JSON.parse(JSON.stringify(config));
  next.memory.links = { ...next.memory.links, enabled: false, autoGenerate: false };
  return next;
};

const disableEvolution: ConfigMutator = (config) => {
  const next: UserConfigFile = JSON.parse(JSON.stringify(config));
  next.memory.evolution = { ...next.memory.evolution, enabled: false };
  return next;
};

const disableLessons: ConfigMutator = (config) => {
  const next: UserConfigFile = JSON.parse(JSON.stringify(config));
  next.memory.lessons = { ...next.memory.lessons, enabled: false };
  return next;
};

const disableConsolidation: ConfigMutator = (config) => {
  const next: UserConfigFile = JSON.parse(JSON.stringify(config));
  next.memory.consolidation = { ...next.memory.consolidation, enabled: false };
  return next;
};
