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

export interface ProvidersPanelState {
  mode: ProvidersPanelMode;
  cursor: number;
  rows: readonly ProviderRow[];
  statusLine: string | null;
  busy: boolean;
  wizard: ProvidersWizardState | null;
  removeConfirm: ProvidersRemoveConfirmState | null;
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
  };
}
