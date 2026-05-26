import type { ProvidersWizardState } from "./providers-wizard-state.js";

export type ProvidersPanelMode = "list";

export type ProviderRow = {
  id: string;
  kind: string;
  isActiveText: boolean;
  isActiveEmbedding: boolean;
  hasApiKey: boolean;
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
