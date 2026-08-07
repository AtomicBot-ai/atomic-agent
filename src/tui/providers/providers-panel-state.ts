import type { ProvidersWizardState } from "./providers-wizard-state.js";

export type ProvidersPanelMode = "list";

export type ProviderRow = {
  id: string;
  kind: string;
  isActiveText: boolean;
  isActiveEmbedding: boolean;
  hasApiKey: boolean;
  /**
   * Stored base URL for `openai-compatible` entries (`null` for curated
   * kinds and when unset). Carried on the row so configure-mode wizards
   * can prefill the URL step instead of opening on an empty field that
   * silently resets a custom endpoint to the OpenAI default.
   */
  baseUrl: string | null;
  chatModel: string | null;
  chatModelOptions?: readonly string[];
  embeddingModel: string | null;
};

export interface ProvidersRemoveConfirmState {
  id: string;
}

/**
 * Reopenable chat-model picker for `openai-compatible` providers, opened
 * from the LLM panel's model row or `/model`. Lives here rather than on
 * `llmPanel` because the async `/v1/models` fetch and the resulting
 * selection are owned by `ProvidersOrchestrator`, matching `wizard` and
 * `removeConfirm`. A non-null value means the modal owns the keyboard.
 *
 * `generation` increments on every open so a response from a previous
 * open (Esc, then reopen for the same provider before the first fetch
 * settles) cannot repopulate the current one.
 */
export interface ProvidersChatModelPickerState {
  providerId: string;
  currentModelId: string | null;
  status: "loading" | "ready" | "error";
  /** Everything the provider offers, unfiltered. */
  models: readonly string[];
  /**
   * Typed filter. Empty string means "no filter"; the picker always
   * renders `filteredModels(picker)` rather than `models` so the cursor
   * and the visible rows agree on one list.
   */
  query: string;
  cursor: number;
  error: string | null;
  generation: number;
}

/**
 * Rows the picker actually shows: every model whose id contains the
 * typed query, case-insensitively. Kept as a helper rather than stored
 * state so the filter can never drift out of sync with `models`.
 */
export function filteredPickerModels(
  picker: ProvidersChatModelPickerState,
): readonly string[] {
  const q = picker.query.trim().toLowerCase();
  if (q.length === 0) return picker.models;
  return picker.models.filter((id) => id.toLowerCase().includes(q));
}

export interface ProvidersPanelState {
  mode: ProvidersPanelMode;
  cursor: number;
  rows: readonly ProviderRow[];
  statusLine: string | null;
  busy: boolean;
  wizard: ProvidersWizardState | null;
  removeConfirm: ProvidersRemoveConfirmState | null;
  chatModelPicker: ProvidersChatModelPickerState | null;
  /** Monotonic counter backing `ProvidersChatModelPickerState.generation`. */
  chatModelPickerGeneration: number;
}

export function createInitialProvidersPanelState(): ProvidersPanelState {
  return {
    mode: "list",
    cursor: 0,
    rows: [],
    statusLine: null,
    busy: false,
    wizard: null,
    removeConfirm: null,
    chatModelPicker: null,
    chatModelPickerGeneration: 0,
  };
}
