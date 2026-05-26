import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handleProvidersWizardKey } from "../providers/providers-wizard-key-bindings.js";

export function handleLlmModalKey(
  input: string,
  key: Key,
  ctx: {
    state: TuiState;
    dispatch: (action: TuiAction) => void;
    callbacks: TuiAppCallbacks;
  },
): boolean | null {
  const { state, dispatch, callbacks } = ctx;
  if (state.providersPanel.wizard !== null) {
    const result = handleProvidersWizardKey(input, key, state.providersPanel.wizard);
    if (!result.handled) return false;
    if ("closed" in result && result.closed) {
      dispatch({ type: "providers_wizard_closed" });
      return true;
    }
    if ("wizard" in result) {
      if ("submit" in result && result.submit) {
        void callbacks.onProvidersWizardSubmit?.(result.wizard);
        return true;
      }
      dispatch({ type: "providers_wizard_updated", wizard: result.wizard });
    }
    return true;
  }

  if (state.providersPanel.removeConfirm !== null) {
    if (state.providersPanel.busy) return true;
    if (key.escape || input.toLowerCase() === "n") {
      dispatch({ type: "providers_remove_closed" });
      return true;
    }
    if (key.return || input.toLowerCase() === "y") {
      dispatch({ type: "providers_remove_confirm_started" });
      callbacks.onProvidersRemove?.(state.providersPanel.removeConfirm.id);
      return true;
    }
    return true;
  }

  if (state.localModelsPanel.embeddingOnboardingPrompt) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      callbacks.onLocalModelsEmbeddingOnboardingResolved?.(true);
      return true;
    }
    if (lower === "n" || key.escape) {
      callbacks.onLocalModelsEmbeddingOnboardingResolved?.(false);
      return true;
    }
    return true;
  }

  if (state.localModelsPanel.removeConfirmId) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      callbacks.onLocalModelsRemoveConfirmed?.(state.localModelsPanel.removeConfirmId);
      dispatch({ type: "local_models_remove_confirm_closed" });
      return true;
    }
    if (lower === "n" || key.escape) {
      dispatch({ type: "local_models_remove_confirm_closed" });
      return true;
    }
    return true;
  }

  if (state.localModelsPanel.embeddingRemoveConfirmId) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      callbacks.onLocalModelsEmbeddingRemoveConfirmed?.(
        state.localModelsPanel.embeddingRemoveConfirmId,
      );
      dispatch({ type: "local_models_embedding_remove_confirm_closed" });
      return true;
    }
    if (lower === "n" || key.escape) {
      dispatch({ type: "local_models_embedding_remove_confirm_closed" });
      return true;
    }
    return true;
  }

  if (state.llmPanel.stopLocalDaemonsPrompt) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      dispatch({ type: "llm_stop_local_daemons_prompt_closed" });
      void callbacks.onLocalModelsDaemonStopRequested?.();
      return true;
    }
    if (lower === "n" || key.escape) {
      dispatch({ type: "llm_stop_local_daemons_prompt_closed" });
      return true;
    }
    return true;
  }

  return null;
}
