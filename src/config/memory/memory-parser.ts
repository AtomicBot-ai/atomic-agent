import type { RewriterGateMode, UserMemoryConfig } from "./memory-types.js";
import { ConfigValidationError } from "../config-validation-error.js";
import {
  parseBool,
  parsePositiveInt,
  parseNonNegativeInt,
  parseUnitInterval,
  parseHalfOpenUnitInterval,
} from "../config-primitives.js";
import { parseStringArrayOrNull } from "../config-values.js";
import {
  PRE_V65_SUBCALL_TIMEOUT_DEFAULTS,
  resolveSubcallTimeoutMs,
} from "../subcall-timeout-migration.js";

/**
 * Files below v22 force `enabled: true` for the seven memory-v2 feature
 * flags. Explicit overrides on v22+ files are still honoured. Embedding
 * model selection is handled separately, without a version migration here.
 */
const MEMORY_V2_OPT_IN_DEFAULTS_VERSION = 22;

function parseMemoryV2FeatureEnabled(
  inputVersion: number,
  raw: unknown,
  defaultEnabled: boolean,
  field: string,
): boolean {
  if (inputVersion < MEMORY_V2_OPT_IN_DEFAULTS_VERSION) {
    return true;
  }
  return parseBool(raw ?? defaultEnabled, field);
}

export function parseRewriterGateMode(
  raw: unknown,
  field: string,
): RewriterGateMode {
  if (raw === "heuristic" || raw === "embedding" || raw === "always") {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected one of heuristic|embedding|always, got ${JSON.stringify(raw)}`,
  );
}

export interface PreparedMemoryInputs {
  memoryProfile: Record<string, unknown>;
  memoryReflection: Record<string, unknown>;
  memoryNotes: Record<string, unknown>;
  memoryRecallInjection: Record<string, unknown>;
  memoryIndex: Record<string, unknown>;
  memoryDedup: Record<string, unknown>;
  memoryEviction: Record<string, unknown>;
  memoryEmbeddings: Record<string, unknown>;
  memoryLinks: Record<string, unknown>;
  memoryEvolution: Record<string, unknown>;
  memoryLessons: Record<string, unknown>;
  memoryProcedures: Record<string, unknown>;
  memoryConsolidation: Record<string, unknown>;
  memoryVoting: Record<string, unknown>;
  memoryReflectionTypedNotes: Record<string, unknown>;
  memoryReflectionSegmentation: Record<string, unknown>;
  memoryRetrieve: Record<string, unknown>;
  memoryRetrieveRewriter: Record<string, unknown>;
  memoryRetrieveRewriterEmbeddingGate: Record<string, unknown>;
}

export function prepareMemoryInputs(
  memory: Record<string, unknown>,
): PreparedMemoryInputs {
  const memoryProfile =
    (memory.profile as Record<string, unknown> | undefined) ?? {};
  const memoryReflection =
    (memory.reflection as Record<string, unknown> | undefined) ?? {};
  const memoryNotes =
    (memory.notes as Record<string, unknown> | undefined) ?? {};
  const memoryRecallInjection =
    (memory.recallInjection as Record<string, unknown> | undefined) ?? {};
  const memoryIndex =
    (memory.index as Record<string, unknown> | undefined) ?? {};
  const memoryDedup =
    (memory.dedup as Record<string, unknown> | undefined) ?? {};
  const memoryEviction =
    (memory.eviction as Record<string, unknown> | undefined) ?? {};
  const memoryEmbeddings =
    (memory.embeddings as Record<string, unknown> | undefined) ?? {};
  const memoryLinks =
    (memory.links as Record<string, unknown> | undefined) ?? {};
  const memoryEvolution =
    (memory.evolution as Record<string, unknown> | undefined) ?? {};
  const memoryLessons =
    (memory.lessons as Record<string, unknown> | undefined) ?? {};
  const memoryProcedures =
    (memory.procedures as Record<string, unknown> | undefined) ?? {};
  const memoryConsolidation =
    (memory.consolidation as Record<string, unknown> | undefined) ?? {};
  const memoryVoting =
    (memory.voting as Record<string, unknown> | undefined) ?? {};
  const memoryReflectionTypedNotes =
    (memoryReflection.typedNotes as Record<string, unknown> | undefined) ?? {};
  const memoryReflectionSegmentation =
    (memoryReflection.segmentation as Record<string, unknown> | undefined) ??
    {};
  const memoryRetrieve =
    (memory.retrieve as Record<string, unknown> | undefined) ?? {};
  const memoryRetrieveRewriter =
    (memoryRetrieve.rewriter as Record<string, unknown> | undefined) ?? {};
  const memoryRetrieveRewriterEmbeddingGate =
    (memoryRetrieveRewriter.embeddingGate as
      Record<string, unknown> | undefined) ?? {};
  return {
    memoryProfile,
    memoryReflection,
    memoryNotes,
    memoryRecallInjection,
    memoryIndex,
    memoryDedup,
    memoryEviction,
    memoryEmbeddings,
    memoryLinks,
    memoryEvolution,
    memoryLessons,
    memoryProcedures,
    memoryConsolidation,
    memoryVoting,
    memoryReflectionTypedNotes,
    memoryReflectionSegmentation,
    memoryRetrieve,
    memoryRetrieveRewriter,
    memoryRetrieveRewriterEmbeddingGate,
  };
}

export function parseMemoryConfig(
  prepared: PreparedMemoryInputs,
  inputVersion: number,
  readDefaults: () => UserMemoryConfig,
): UserMemoryConfig {
  const {
    memoryProfile,
    memoryReflection,
    memoryNotes,
    memoryRecallInjection,
    memoryIndex,
    memoryDedup,
    memoryEviction,
    memoryEmbeddings,
    memoryLinks,
    memoryEvolution,
    memoryLessons,
    memoryProcedures,
    memoryConsolidation,
    memoryVoting,
    memoryReflectionTypedNotes,
    memoryReflectionSegmentation,
    memoryRetrieveRewriter,
    memoryRetrieveRewriterEmbeddingGate,
  } = prepared;
  return {
    profile: {
      enabled: parseBool(
        memoryProfile.enabled ?? readDefaults().profile.enabled,
        "memory.profile.enabled",
      ),
      maxTokens: parsePositiveInt(
        memoryProfile.maxTokens ??
          readDefaults().profile.maxTokens,
        "memory.profile.maxTokens",
      ),
      contextualKeywordGate: parseBool(
        memoryProfile.contextualKeywordGate ??
          readDefaults().profile.contextualKeywordGate,
        "memory.profile.contextualKeywordGate",
      ),
      maxEntries: parsePositiveInt(
        memoryProfile.maxEntries ??
          readDefaults().profile.maxEntries,
        "memory.profile.maxEntries",
      ),
    },
    reflection: {
      enabled: parseBool(
        memoryReflection.enabled ??
          readDefaults().reflection.enabled,
        "memory.reflection.enabled",
      ),
      timeoutMs: resolveSubcallTimeoutMs(
        inputVersion,
        parsePositiveInt(
          memoryReflection.timeoutMs ??
            readDefaults().reflection.timeoutMs,
          "memory.reflection.timeoutMs",
        ),
        PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.reflectionTimeoutMs,
        readDefaults().reflection.timeoutMs,
      ),
      maxFactsPerCall: parsePositiveInt(
        memoryReflection.maxFactsPerCall ??
          readDefaults().reflection.maxFactsPerCall,
        "memory.reflection.maxFactsPerCall",
      ),
      autoStoreNotes: parseBool(
        memoryReflection.autoStoreNotes ??
          readDefaults().reflection.autoStoreNotes,
        "memory.reflection.autoStoreNotes",
      ),
      maxNotesPerCall: parseNonNegativeInt(
        memoryReflection.maxNotesPerCall ??
          readDefaults().reflection.maxNotesPerCall,
        "memory.reflection.maxNotesPerCall",
      ),
      typedNotes: {
        enabled: parseBool(
          memoryReflectionTypedNotes.enabled ??
            readDefaults().reflection.typedNotes.enabled,
          "memory.reflection.typedNotes.enabled",
        ),
      },
      anySpeaker: parseBool(
        memoryReflection.anySpeaker ??
          readDefaults().reflection.anySpeaker,
        "memory.reflection.anySpeaker",
      ),
      segmentation: {
        enabled: parseBool(
          memoryReflectionSegmentation.enabled ??
            readDefaults().reflection.segmentation.enabled,
          "memory.reflection.segmentation.enabled",
        ),
        triggerEveryTurns: parsePositiveInt(
          memoryReflectionSegmentation.triggerEveryTurns ??
            readDefaults().reflection.segmentation
              .triggerEveryTurns,
          "memory.reflection.segmentation.triggerEveryTurns",
        ),
        windowTurns: parsePositiveInt(
          memoryReflectionSegmentation.windowTurns ??
            readDefaults().reflection.segmentation.windowTurns,
          "memory.reflection.segmentation.windowTurns",
        ),
      },
    },
    notes: {
      enabled: parseBool(
        memoryNotes.enabled ?? readDefaults().notes.enabled,
        "memory.notes.enabled",
      ),
      maxEntries: parsePositiveInt(
        memoryNotes.maxEntries ??
          readDefaults().notes.maxEntries,
        "memory.notes.maxEntries",
      ),
      maxContentChars: parsePositiveInt(
        memoryNotes.maxContentChars ??
          readDefaults().notes.maxContentChars,
        "memory.notes.maxContentChars",
      ),
      recallDefaultK: parsePositiveInt(
        memoryNotes.recallDefaultK ??
          readDefaults().notes.recallDefaultK,
        "memory.notes.recallDefaultK",
      ),
    },
    recallInjection: {
      enabled: parseBool(
        memoryRecallInjection.enabled ??
          readDefaults().recallInjection.enabled,
        "memory.recallInjection.enabled",
      ),
      k: parseNonNegativeInt(
        memoryRecallInjection.k ??
          readDefaults().recallInjection.k,
        "memory.recallInjection.k",
      ),
      previewChars: parsePositiveInt(
        memoryRecallInjection.previewChars ??
          readDefaults().recallInjection.previewChars,
        "memory.recallInjection.previewChars",
      ),
      maxTokens: parsePositiveInt(
        memoryRecallInjection.maxTokens ??
          readDefaults().recallInjection.maxTokens,
        "memory.recallInjection.maxTokens",
      ),
    },
    index: {
      enabled: parseBool(
        memoryIndex.enabled ?? readDefaults().index.enabled,
        "memory.index.enabled",
      ),
      limit: parseNonNegativeInt(
        memoryIndex.limit ?? readDefaults().index.limit,
        "memory.index.limit",
      ),
      previewChars: parsePositiveInt(
        memoryIndex.previewChars ??
          readDefaults().index.previewChars,
        "memory.index.previewChars",
      ),
      maxTokens: parsePositiveInt(
        memoryIndex.maxTokens ?? readDefaults().index.maxTokens,
        "memory.index.maxTokens",
      ),
    },
    dedup: {
      enabled: parseBool(
        memoryDedup.enabled ?? readDefaults().dedup.enabled,
        "memory.dedup.enabled",
      ),
      fts5Threshold: parseUnitInterval(
        memoryDedup.fts5Threshold ??
          readDefaults().dedup.fts5Threshold,
        "memory.dedup.fts5Threshold",
      ),
    },
    eviction: {
      utilityWeighted: parseBool(
        memoryEviction.utilityWeighted ??
          readDefaults().eviction.utilityWeighted,
        "memory.eviction.utilityWeighted",
      ),
      maxAgeMs: parsePositiveInt(
        memoryEviction.maxAgeMs ??
          readDefaults().eviction.maxAgeMs,
        "memory.eviction.maxAgeMs",
      ),
    },
    embeddings: {
      enabled: parseBool(
        memoryEmbeddings.enabled ??
          readDefaults().embeddings.enabled,
        "memory.embeddings.enabled",
      ),
      fts5Weight: parseUnitInterval(
        memoryEmbeddings.fts5Weight ??
          readDefaults().embeddings.fts5Weight,
        "memory.embeddings.fts5Weight",
      ),
      vectorWeight: parseUnitInterval(
        memoryEmbeddings.vectorWeight ??
          readDefaults().embeddings.vectorWeight,
        "memory.embeddings.vectorWeight",
      ),
      bruteForceCeiling: parsePositiveInt(
        memoryEmbeddings.bruteForceCeiling ??
          readDefaults().embeddings.bruteForceCeiling,
        "memory.embeddings.bruteForceCeiling",
      ),
    },
    links: {
      enabled: parseMemoryV2FeatureEnabled(
        inputVersion,
        memoryLinks.enabled,
        readDefaults().links.enabled,
        "memory.links.enabled",
      ),
      autoGenerate: parseBool(
        memoryLinks.autoGenerate ??
          readDefaults().links.autoGenerate,
        "memory.links.autoGenerate",
      ),
      expansionDepth: parsePositiveInt(
        memoryLinks.expansionDepth ??
          readDefaults().links.expansionDepth,
        "memory.links.expansionDepth",
      ),
      maxExpanded: parsePositiveInt(
        memoryLinks.maxExpanded ??
          readDefaults().links.maxExpanded,
        "memory.links.maxExpanded",
      ),
      maxLinksPerCall: parsePositiveInt(
        memoryLinks.maxLinksPerCall ??
          readDefaults().links.maxLinksPerCall,
        "memory.links.maxLinksPerCall",
      ),
      minCandidates: parsePositiveInt(
        memoryLinks.minCandidates ??
          readDefaults().links.minCandidates,
        "memory.links.minCandidates",
      ),
      generatorTimeoutMs: resolveSubcallTimeoutMs(
        inputVersion,
        parsePositiveInt(
          memoryLinks.generatorTimeoutMs ??
            readDefaults().links.generatorTimeoutMs,
          "memory.links.generatorTimeoutMs",
        ),
        PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.linkGeneratorTimeoutMs,
        readDefaults().links.generatorTimeoutMs,
      ),
    },
    evolution: {
      enabled: parseMemoryV2FeatureEnabled(
        inputVersion,
        memoryEvolution.enabled,
        readDefaults().evolution.enabled,
        "memory.evolution.enabled",
      ),
      maxPerWrite: parsePositiveInt(
        memoryEvolution.maxPerWrite ??
          readDefaults().evolution.maxPerWrite,
        "memory.evolution.maxPerWrite",
      ),
      leaseMs: parsePositiveInt(
        memoryEvolution.leaseMs ??
          readDefaults().evolution.leaseMs,
        "memory.evolution.leaseMs",
      ),
    },
    lessons: {
      enabled: parseMemoryV2FeatureEnabled(
        inputVersion,
        memoryLessons.enabled,
        readDefaults().lessons.enabled,
        "memory.lessons.enabled",
      ),
      recallK: parsePositiveInt(
        memoryLessons.recallK ?? readDefaults().lessons.recallK,
        "memory.lessons.recallK",
      ),
      maxTokens: parsePositiveInt(
        memoryLessons.maxTokens ??
          readDefaults().lessons.maxTokens,
        "memory.lessons.maxTokens",
      ),
      indexLimit: parsePositiveInt(
        memoryLessons.indexLimit ??
          readDefaults().lessons.indexLimit,
        "memory.lessons.indexLimit",
      ),
      maxEntries: parsePositiveInt(
        memoryLessons.maxEntries ??
          readDefaults().lessons.maxEntries,
        "memory.lessons.maxEntries",
      ),
      deprecationAgeMs: parsePositiveInt(
        memoryLessons.deprecationAgeMs ??
          readDefaults().lessons.deprecationAgeMs,
        "memory.lessons.deprecationAgeMs",
      ),
    },
    procedures: {
      enabled: parseMemoryV2FeatureEnabled(
        inputVersion,
        memoryProcedures.enabled,
        readDefaults().procedures.enabled,
        "memory.procedures.enabled",
      ),
      recallK: parsePositiveInt(
        memoryProcedures.recallK ??
          readDefaults().procedures.recallK,
        "memory.procedures.recallK",
      ),
      maxTokens: parsePositiveInt(
        memoryProcedures.maxTokens ??
          readDefaults().procedures.maxTokens,
        "memory.procedures.maxTokens",
      ),
      indexLimit: parsePositiveInt(
        memoryProcedures.indexLimit ??
          readDefaults().procedures.indexLimit,
        "memory.procedures.indexLimit",
      ),
      maxEntries: parsePositiveInt(
        memoryProcedures.maxEntries ??
          readDefaults().procedures.maxEntries,
        "memory.procedures.maxEntries",
      ),
      deprecationAgeMs: parsePositiveInt(
        memoryProcedures.deprecationAgeMs ??
          readDefaults().procedures.deprecationAgeMs,
        "memory.procedures.deprecationAgeMs",
      ),
    },
    consolidation: {
      enabled: parseMemoryV2FeatureEnabled(
        inputVersion,
        memoryConsolidation.enabled,
        readDefaults().consolidation.enabled,
        "memory.consolidation.enabled",
      ),
      intervalMs: parsePositiveInt(
        memoryConsolidation.intervalMs ??
          readDefaults().consolidation.intervalMs,
        "memory.consolidation.intervalMs",
      ),
      cooldownMs: parsePositiveInt(
        memoryConsolidation.cooldownMs ??
          readDefaults().consolidation.cooldownMs,
        "memory.consolidation.cooldownMs",
      ),
      minClusterSize: parsePositiveInt(
        memoryConsolidation.minClusterSize ??
          readDefaults().consolidation.minClusterSize,
        "memory.consolidation.minClusterSize",
      ),
      maxClustersPerTick: parsePositiveInt(
        memoryConsolidation.maxClustersPerTick ??
          readDefaults().consolidation.maxClustersPerTick,
        "memory.consolidation.maxClustersPerTick",
      ),
      requireSharedTag: parseBool(
        memoryConsolidation.requireSharedTag ??
          readDefaults().consolidation.requireSharedTag,
        "memory.consolidation.requireSharedTag",
      ),
      distillTimeoutMs: parsePositiveInt(
        memoryConsolidation.distillTimeoutMs ??
          readDefaults().consolidation.distillTimeoutMs,
        "memory.consolidation.distillTimeoutMs",
      ),
    },
    voting: {
      enabled: parseMemoryV2FeatureEnabled(
        inputVersion,
        memoryVoting.enabled,
        readDefaults().voting.enabled,
        "memory.voting.enabled",
      ),
      maxVotePerItem: parsePositiveInt(
        memoryVoting.maxVotePerItem ??
          readDefaults().voting.maxVotePerItem,
        "memory.voting.maxVotePerItem",
      ),
      signalDecay: parseHalfOpenUnitInterval(
        memoryVoting.signalDecay ??
          readDefaults().voting.signalDecay,
        "memory.voting.signalDecay",
      ),
      scoreBlend: parseUnitInterval(
        memoryVoting.scoreBlend ??
          readDefaults().voting.scoreBlend,
        "memory.voting.scoreBlend",
      ),
      eventLogMaxRows: parseNonNegativeInt(
        memoryVoting.eventLogMaxRows ??
          readDefaults().voting.eventLogMaxRows,
        "memory.voting.eventLogMaxRows",
      ),
      profileFilterThreshold: parsePositiveInt(
        memoryVoting.profileFilterThreshold ??
          readDefaults().voting.profileFilterThreshold,
        "memory.voting.profileFilterThreshold",
      ),
    },
    retrieve: {
      rewriter: {
        enabled: parseMemoryV2FeatureEnabled(
          inputVersion,
          memoryRetrieveRewriter.enabled,
          readDefaults().retrieve.rewriter.enabled,
          "memory.retrieve.rewriter.enabled",
        ),
        timeoutMs: resolveSubcallTimeoutMs(
          inputVersion,
          parsePositiveInt(
            memoryRetrieveRewriter.timeoutMs ??
              readDefaults().retrieve.rewriter.timeoutMs,
            "memory.retrieve.rewriter.timeoutMs",
          ),
          PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.rewriterTimeoutMs,
          readDefaults().retrieve.rewriter.timeoutMs,
        ),
        historyTurns: parsePositiveInt(
          memoryRetrieveRewriter.historyTurns ??
            readDefaults().retrieve.rewriter.historyTurns,
          "memory.retrieve.rewriter.historyTurns",
        ),
        gateMode: parseRewriterGateMode(
          memoryRetrieveRewriter.gateMode ??
            readDefaults().retrieve.rewriter.gateMode,
          "memory.retrieve.rewriter.gateMode",
        ),
        embeddingGate: {
          threshold: parseUnitInterval(
            memoryRetrieveRewriterEmbeddingGate.threshold ??
              readDefaults().retrieve.rewriter.embeddingGate
                .threshold,
            "memory.retrieve.rewriter.embeddingGate.threshold",
          ),
          exemplars: parseStringArrayOrNull(
            memoryRetrieveRewriterEmbeddingGate.exemplars ??
              readDefaults().retrieve.rewriter.embeddingGate
                .exemplars,
            "memory.retrieve.rewriter.embeddingGate.exemplars",
          ),
        },
      },
    },
  };
}
