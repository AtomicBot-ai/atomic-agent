import type { Key } from "ink";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { getCachedOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
import {
  listAimlapiChatModels,
  listAimlapiEmbeddingModels,
  listOpenRouterChatModels,
  listOpenRouterEmbeddingModels,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
} from "./providers-model-options.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardPhase,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

const KIND_COUNT = 3;

/** Maps the `pick_kind` cursor index to the actual kind. */
const KIND_ORDER: readonly ProvidersWizardKind[] = [
  "openrouter",
  "aimlapi",
  "openai-compatible",
];

function kindAtCursor(cursor: number): ProvidersWizardKind {
  return KIND_ORDER[cursor] ?? "openrouter";
}

function isCuratedCatalogKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): boolean {
  return kind === "openrouter" || kind === "aimlapi";
}

function listChatModelsForKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): ReturnType<typeof listOpenRouterChatModels> {
  if (kind === "aimlapi") return listAimlapiChatModels();
  return listOpenRouterChatModels();
}

function listEmbeddingModelsForKind(
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

function advanceWizardPhase(
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
    const picked = models[wizard.cursor]?.id ?? models[0]?.id ?? null;
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

function listLengthForPhase(
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

function isListPhase(phase: ProvidersWizardPhase): boolean {
  return (
    phase === "pick_kind" ||
    phase === "pick_chat_model" ||
    phase === "pick_embedding"
  );
}

function isLinePhase(phase: ProvidersWizardPhase): boolean {
  return (
    phase === "base_url" ||
    phase === "chat_model_line" ||
    phase === "embedding_model_line"
  );
}

/** Normalized so the fetch, the cache key and the displayed URL always agree. */
export function baseUrlForWizard(wizard: ProvidersWizardState): string {
  return (
    normalizeOpenAiBaseUrl(wizard.baseUrlLine) || OPENAI_COMPAT_DEFAULT_BASE_URL
  );
}

/** Typed key wins; otherwise a key already in the environment needs no retyping. */
export function apiKeyForWizard(
  wizard: ProvidersWizardState,
): string | undefined {
  return (
    wizard.apiKeyBuffer.trim() ||
    resolveLlmProviderApiKey({
      id: "openai-compatible",
      kind: "openai-compatible",
    })
  );
}

/**
 * Chat model ids discovered from `{baseUrl}/v1/models`. Empty once the operator
 * types anything — a typed id is a deliberate override, so the picker steps
 * aside (backspacing back to empty brings it back).
 */
export function listCompatChatModelPicks(
  wizard: ProvidersWizardState,
): readonly string[] {
  if (wizard.phase !== "chat_model_line") return [];
  if (wizard.kind !== "openai-compatible") return [];
  if (wizard.chatModelLine.length > 0) return [];
  return (
    getCachedOpenAiCompatModels(
      baseUrlForWizard(wizard),
      apiKeyForWizard(wizard),
    ) ?? []
  );
}

export type ProvidersWizardKeyResult =
  | { handled: true; wizard: ProvidersWizardState; submit?: false }
  | { handled: true; wizard: ProvidersWizardState; submit: true }
  | { handled: true; closed: true }
  | { handled: false };

export function handleProvidersWizardKey(
  input: string,
  key: Key,
  wizard: ProvidersWizardState,
): ProvidersWizardKeyResult {
  if (wizard.submitting) {
    return { handled: true, wizard };
  }
  if (key.escape) {
    return { handled: true, closed: true };
  }

  if (wizard.phase === "api_key") {
    if (key.return) {
      return {
        handled: true,
        wizard: advanceWizardPhase(wizard),
      };
    }
    if (key.backspace || key.delete) {
      return {
        handled: true,
        wizard: {
          ...wizard,
          apiKeyBuffer: wizard.apiKeyBuffer.slice(0, -1),
          error: null,
        },
      };
    }
    if (input && input.length > 0 && !key.ctrl && !key.meta) {
      return {
        handled: true,
        wizard: {
          ...wizard,
          apiKeyBuffer: wizard.apiKeyBuffer + input,
          error: null,
        },
      };
    }
    return { handled: true, wizard };
  }

  if (isLinePhase(wizard.phase)) {
    const picks = listCompatChatModelPicks(wizard);
    if (picks.length > 0) {
      // Arrows only: printable keys fall through to line editing so an id the
      // server does not advertise can still be typed.
      if (key.downArrow) {
        return {
          handled: true,
          wizard: { ...wizard, cursor: (wizard.cursor + 1) % picks.length },
        };
      }
      if (key.upArrow) {
        return {
          handled: true,
          wizard: {
            ...wizard,
            cursor: (wizard.cursor - 1 + picks.length) % picks.length,
          },
        };
      }
      if (key.return) {
        const picked = picks[wizard.cursor] ?? picks[0]!;
        return {
          handled: true,
          wizard: advanceWizardPhase({ ...wizard, chatModelLine: picked }),
        };
      }
    }
    const field =
      wizard.phase === "base_url"
        ? "baseUrlLine"
        : wizard.phase === "chat_model_line"
          ? "chatModelLine"
          : "embeddingModelLine";
    if (key.return) {
      if (wizard.phase === "embedding_model_line") {
        return { handled: true, wizard, submit: true };
      }
      return {
        handled: true,
        wizard: advanceWizardPhase(wizard),
      };
    }
    if (key.backspace || key.delete) {
      const line = wizard[field];
      return {
        handled: true,
        wizard: {
          ...wizard,
          [field]: line.slice(0, -1),
          error: null,
        } as ProvidersWizardState,
      };
    }
    if (input && input.length > 0 && !key.ctrl && !key.meta) {
      const line = wizard[field];
      return {
        handled: true,
        wizard: {
          ...wizard,
          [field]: line + input,
          error: null,
        } as ProvidersWizardState,
      };
    }
    return { handled: true, wizard };
  }

  if (!isListPhase(wizard.phase)) {
    return { handled: false };
  }

  const len = listLengthForPhase(wizard.phase, wizard.kind);
  if (len === 0) {
    return { handled: true, wizard };
  }

  if (key.downArrow || input === "j") {
    return {
      handled: true,
      wizard: { ...wizard, cursor: (wizard.cursor + 1) % len },
    };
  }
  if (key.upArrow || input === "k") {
    return {
      handled: true,
      wizard: {
        ...wizard,
        cursor: (wizard.cursor - 1 + len) % len,
      },
    };
  }
  if (key.return) {
    if (wizard.phase === "pick_kind") {
      const kind = kindAtCursor(wizard.cursor);
      return {
        handled: true,
        wizard: advanceWizardPhase({
          ...wizard,
          kind,
        }),
      };
    }
    if (
      wizard.phase === "pick_embedding" &&
      wizard.kind &&
      isCuratedCatalogKind(wizard.kind)
    ) {
      const models = listEmbeddingModelsForKind(wizard.kind);
      const picked = models[wizard.cursor]?.id ?? models[0]?.id ?? null;
      return {
        handled: true,
        wizard: {
          ...wizard,
          selectedEmbeddingChoiceId: picked,
        },
        submit: true,
      };
    }
    return {
      handled: true,
      wizard: advanceWizardPhase(wizard),
    };
  }
  return { handled: true, wizard };
}
