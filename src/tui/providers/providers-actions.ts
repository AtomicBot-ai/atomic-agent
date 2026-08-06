import type { ProviderRow } from "./providers-panel-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

export type ProvidersAction =
  | { type: "providers_refresh_requested" }
  | { type: "providers_refresh"; rows: readonly ProviderRow[] }
  | { type: "providers_set_active_text"; id: string }
  | { type: "providers_select_chat_model"; providerId: string; modelId: string }
  | {
      type: "providers_select_embedding_model";
      providerId: string;
      modelId: string;
    }
  | { type: "providers_set_active_embedding"; id: string }
  | { type: "providers_cursor_down" }
  | { type: "providers_cursor_up" }
  | { type: "providers_status"; line: string | null }
  | { type: "providers_busy"; busy: boolean }
  | { type: "providers_wizard_opened"; wizard: ProvidersWizardState }
  | { type: "providers_catalog_refresh_requested" }
  | {
      /**
       * Open the reopenable chat-model picker for an `openai-compatible`
       * provider. `providerId: null` targets the active text provider
       * (`/model`). Handled by `ProvidersOrchestrator`, which owns the
       * async list fetch and emits the `llm_model_picker_*` transitions.
       */
      type: "providers_chat_model_picker_requested";
      providerId: string | null;
    }
  | { type: "providers_wizard_updated"; wizard: ProvidersWizardState }
  | { type: "providers_wizard_closed" }
  | { type: "providers_wizard_submit_started" }
  | { type: "providers_wizard_failed"; error: string }
  | { type: "providers_wizard_succeeded" }
  | { type: "providers_remove_opened"; id: string }
  | { type: "providers_remove_closed" }
  | { type: "providers_remove_confirm_started" }
  | { type: "providers_remove_failed"; error: string }
  | { type: "providers_remove_succeeded" };

export function isProvidersAction(
  action: { type: string },
): action is ProvidersAction {
  return action.type.startsWith("providers_");
}
