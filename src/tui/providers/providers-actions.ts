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
  /** Put the provider-list cursor on an absolute row (mouse click). */
  | { type: "providers_cursor_set"; row: number }
  | {
      /**
       * `source` says which pane the line belongs to: the cloud
       * providers list (default), or the External pane's URL-save
       * verdicts. Without it the External pane rendered every
       * cloud-provider status verbatim — catalog refreshes included.
       */
      type: "providers_status";
      line: string | null;
      source?: "cloud" | "external";
    }
  | { type: "providers_busy"; busy: boolean }
  | { type: "providers_wizard_opened"; wizard: ProvidersWizardState }
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
  | {
      type: "providers_chat_model_picker_opened";
      providerId: string;
      currentModelId: string | null;
      generation: number;
    }
  | {
      type: "providers_chat_model_picker_loaded";
      generation: number;
      models: readonly string[];
    }
  | { type: "providers_chat_model_picker_failed"; generation: number; error: string }
  | { type: "providers_chat_model_picker_cursor_set"; cursor: number }
  | { type: "providers_chat_model_picker_query_set"; query: string }
  | { type: "providers_chat_model_picker_closed" }
  | {
      /**
       * Make sure the Cloud pane's inline model list has (or is
       * fetching) the catalog of `providerId` (`null` = active text
       * provider). Dispatched by `/model`; `submit-handler` intercepts
       * it and routes it through the
       * `onProvidersInlineModelsEnsureRequested` callback into
       * `ProvidersOrchestrator.ensureInlineModels`, because a dispatched
       * reducer action never reaches the event bus the orchestrator
       * listens on (same rule as the picker request above).
       */
      type: "providers_inline_models_ensure_requested";
      providerId: string | null;
    }
  | {
      /**
       * Inline Cloud-pane model list transitions, emitted by
       * `ProvidersOrchestrator.ensureInlineModels` on the event bus.
       */
      type: "providers_inline_models_loading";
      providerId: string;
      generation: number;
    }
  | {
      type: "providers_inline_models_loaded";
      providerId: string;
      generation: number;
      models: readonly string[];
    }
  | {
      type: "providers_inline_models_failed";
      providerId: string;
      generation: number;
      error: string;
    }
  | {
      /**
       * Run the side-effect-free provider contract probe against
       * `providerId` (`null` = active text provider), on explicit
       * operator request (`/llm check`). Handled by
       * `ProvidersOrchestrator.runContractProbe`; `submit-handler`
       * routes it through `onProvidersContractProbeRequested` for the
       * same reason as the picker request above — a dispatched reducer
       * action never reaches the event bus the orchestrator listens on.
       */
      type: "providers_contract_probe_requested";
      providerId: string | null;
    }
  | { type: "providers_wizard_updated"; wizard: ProvidersWizardState }
  | { type: "providers_wizard_closed" }
  | { type: "providers_wizard_submit_started" }
  | { type: "providers_wizard_failed"; error: string }
  | { type: "providers_wizard_verify_cancelled" }
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
