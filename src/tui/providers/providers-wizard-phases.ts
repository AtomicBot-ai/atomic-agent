import { PROVIDER_PRESETS } from "./provider-presets.js";
import {
  listAimlapiChatModels,
  listAimlapiEmbeddingModels,
  listOpenRouterChatModels,
  listOpenRouterEmbeddingModels,
} from "./providers-model-options.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardPhase,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

/**
 * Rows on the provider step: the two kinds with built-in catalogs, then
 * every known service as its own row, then the manual escape hatch.
 * Preset rows are not new provider kinds, they resolve to
 * `openai-compatible` with a verified base URL filled in (#69), which is
 * the same flat shape Hermes and OpenClaw present.
 */
export type ProvidersWizardKindRow =
  | ProvidersWizardKind
  | { readonly presetId: string };

/**
 * The single source of row order for `pick_kind`. The render layer
 * derives its labels from this list, so cursor index and label can
 * never disagree.
 */
export const KIND_ROW_ORDER: readonly ProvidersWizardKindRow[] = [
  "openrouter",
  "aimlapi",
  ...PROVIDER_PRESETS.map((preset) => ({ presetId: preset.id })),
  "openai-compatible",
];

const KIND_COUNT = KIND_ROW_ORDER.length;

/** Maps the `pick_kind` cursor index to the row (kind or preset). */
export function kindRowAtCursor(cursor: number): ProvidersWizardKindRow {
  return KIND_ROW_ORDER[cursor] ?? "openrouter";
}

export function isCuratedCatalogKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): boolean {
  return kind === "openrouter" || kind === "aimlapi";
}

export function listChatModelsForKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): ReturnType<typeof listOpenRouterChatModels> {
  if (kind === "aimlapi") return listAimlapiChatModels();
  return listOpenRouterChatModels();
}

export function listEmbeddingModelsForKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): ReturnType<typeof listOpenRouterEmbeddingModels> {
  if (kind === "aimlapi") return listAimlapiEmbeddingModels();
  return listOpenRouterEmbeddingModels();
}

function nextPhaseAfterApiKey(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): ProvidersWizardPhase {
  if (isCuratedCatalogKind(kind)) return "pick_chat_model";
  return "base_url";
}

/**
 * Last valid index for `cursor`, `0` for an empty list. The live catalog
 * cache can be replaced under an open wizard (TTL refresh finishing
 * between two keypresses), so every read of `wizard.cursor` against a
 * list must clamp first: the render layer highlights the clamped row,
 * and selection has to pick that same row, never `models[0]`.
 */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(cursor, 0), length - 1);
}

export function advanceWizardPhase(
  wizard: ProvidersWizardState,
): ProvidersWizardState {
  const { phase, kind } = wizard;
  if (phase === "pick_kind" && kind) {
    return { ...wizard, phase: "api_key", cursor: 0, error: null };
  }
  if (phase === "api_key" && kind) {
    return {
      ...wizard,
      phase: nextPhaseAfterApiKey(kind),
      cursor: 0,
      error: null,
    };
  }
  if (phase === "pick_chat_model" && kind && isCuratedCatalogKind(kind)) {
    const models = listChatModelsForKind(kind);
    // Clamped, not `?? models[0]`: when the catalog shrank under the
    // cursor, the highlighted row is the last one, and Enter must select
    // exactly what is highlighted.
    const picked = models[clampCursor(wizard.cursor, models.length)]?.id ?? null;
    return {
      ...wizard,
      phase: "pick_embedding",
      cursor: 0,
      selectedChatModelId: picked,
      error: null,
    };
  }
  if (phase === "base_url" && kind === "openai-compatible") {
    return { ...wizard, phase: "chat_model_line", cursor: 0, error: null };
  }
  if (phase === "chat_model_line" && kind === "openai-compatible") {
    return { ...wizard, phase: "embedding_model_line", cursor: 0, error: null };
  }
  return wizard;
}

export function listLengthForPhase(
  phase: ProvidersWizardPhase,
  kind: ProvidersWizardState["kind"],
): number {
  if (phase === "pick_kind") return KIND_COUNT;
  if (phase === "pick_chat_model" && kind && isCuratedCatalogKind(kind)) {
    return listChatModelsForKind(kind).length;
  }
  if (phase === "pick_embedding" && kind && isCuratedCatalogKind(kind)) {
    return listEmbeddingModelsForKind(kind).length;
  }
  return 0;
}

export function isListPhase(phase: ProvidersWizardPhase): boolean {
  return (
    phase === "pick_kind" ||
    phase === "pick_chat_model" ||
    phase === "pick_embedding"
  );
}

export function isLinePhase(phase: ProvidersWizardPhase): boolean {
  return (
    phase === "base_url" ||
    phase === "chat_model_line" ||
    phase === "embedding_model_line"
  );
}
