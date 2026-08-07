import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handleProvidersWizardKey } from "../providers/providers-wizard-key-bindings.js";
import { normalizeLocalLlmBaseUrl } from "../persist-user-local-models-config.js";
import { filteredPickerModels } from "../providers/providers-panel-state.js";
import { stopLocalDaemonsForCloudSelection } from "./llm-panel-primary-actions.js";

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

  const picker = state.providersPanel.chatModelPicker;
  if (picker !== null) {
    if (key.escape) {
      dispatch({ type: "providers_chat_model_picker_closed" });
      return true;
    }
    if (picker.status === "ready") {
      const rows = filteredPickerModels(picker);
      if (key.upArrow || key.downArrow) {
        if (rows.length === 0) return true;
        const delta = key.downArrow ? 1 : -1;
        const next = (picker.cursor + delta + rows.length) % rows.length;
        dispatch({ type: "providers_chat_model_picker_cursor_set", cursor: next });
        return true;
      }
      if (key.return) {
        const modelId = rows[picker.cursor];
        if (modelId === undefined) return true;
        dispatch({ type: "providers_chat_model_picker_closed" });
        callbacks.onProvidersSelectChatModel?.(picker.providerId, modelId);
        stopLocalDaemonsForCloudSelection(state, callbacks);
        return true;
      }
      if (key.backspace || key.delete) {
        dispatch({
          type: "providers_chat_model_picker_query_set",
          query: picker.query.slice(0, -1),
        });
        return true;
      }
      // Printable keys type into the filter. Modifier combos are left
      // alone so global hotkeys keep working while the modal is open.
      if (input && input.length > 0 && !key.ctrl && !key.meta) {
        dispatch({
          type: "providers_chat_model_picker_query_set",
          query: picker.query + input,
        });
        return true;
      }
    }
    if (key.return && picker.status === "error") {
      dispatch({ type: "providers_chat_model_picker_closed" });
      return true;
    }
    // Loading (or any other key): the modal owns the keyboard.
    return true;
  }

  const urlDraft = state.llmPanel.externalUrlDraft;
  if (urlDraft !== null) {
    if (key.escape) {
      dispatch({ type: "llm_external_url_draft_set", value: null });
      return true;
    }
    if (key.return) {
      const url = parseExternalUrl(urlDraft);
      // Unparseable input keeps the editor open — it already renders an
      // "invalid URL" hint, so closing here would swallow the mistake.
      if (url === null) return true;
      dispatch({ type: "llm_external_url_draft_set", value: null });
      callbacks.onPersistLlamaUrl?.(url);
      return true;
    }
    if (key.backspace || key.delete) {
      dispatch({
        type: "llm_external_url_draft_set",
        value: urlDraft.slice(0, -1),
      });
      return true;
    }
    if (input && input.length > 0 && !key.ctrl && !key.meta) {
      dispatch({ type: "llm_external_url_draft_set", value: urlDraft + input });
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

/**
 * Normalize a typed base URL (adds the `http://` scheme when omitted), or
 * `null` when it is empty / unparseable. Shared with the modal renderer so
 * the "invalid URL" hint and the Enter guard never disagree.
 */
export function parseExternalUrl(draft: string): string | null {
  try {
    return normalizeLocalLlmBaseUrl(draft);
  } catch {
    return null;
  }
}
