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
 * Reopenable chat-model picker modal. The Cloud pane replaced it with
 * the inline filterable model list (`InlineModelCatalogState` below), so
 * the modal no longer has an entry point there; it stays for non-panel
 * flows that need a standalone picker. Lives here rather than on
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
  return filterModelIds(picker.models, picker.query);
}

/**
 * Case-insensitive substring filter over model ids. Shared by the modal
 * picker and the inline Cloud-pane model list so both surfaces match the
 * same rows for the same query.
 */
export function filterModelIds(
  models: readonly string[],
  query: string,
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return models;
  return models.filter((id) => id.toLowerCase().includes(q));
}

/**
 * Live model catalog behind the Cloud pane's inline "Cloud text models"
 * section. Owned by `ProvidersOrchestrator.ensureInlineModels`, which is
 * the only writer: curated kinds (OpenRouter, aimlapi) load synchronously
 * from their catalog module and never populate this state, while
 * `openai-compatible` drives the async `/v1/models` fetch with a visible
 * `loading` state and an `error` state that falls back to a single
 * current-model row.
 *
 * `generation` mirrors the modal picker's stale-response guard: a fetch
 * that settles after the operator already switched providers must not
 * repopulate the section with the previous provider's models.
 */
export interface InlineModelCatalogState {
  providerId: string;
  status: "loading" | "ready" | "error";
  models: readonly string[];
  error: string | null;
  generation: number;
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
  /** Inline Cloud-pane model catalog; `null` until first ensured. */
  inlineModels: InlineModelCatalogState | null;
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
    inlineModels: null,
  };
}
