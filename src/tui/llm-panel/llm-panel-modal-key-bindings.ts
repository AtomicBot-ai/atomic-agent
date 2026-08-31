import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handleProvidersWizardKey } from "../providers/providers-wizard-key-bindings.js";
import { wizardForOpenAiCompatUrl } from "../providers/openai-compat-steer.js";
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
      if ("cancelSubmit" in result && result.cancelSubmit) {
        callbacks.onProvidersWizardSubmitCancel?.();
        return true;
      }
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
        // Nothing to erase: dispatching would reset the cursor to the top
        // of the list for no reason, so swallow the key instead.
        if (picker.query.length === 0) return true;
        dispatch({
          type: "providers_chat_model_picker_query_set",
          query: picker.query.slice(0, -1),
        });
        return true;
      }
      // Printable keys type into the filter. The guard is explicit
      // rather than "anything with input": Ink 7's parse-keypress
      // reports input === "" for Tab, arrows and PgUp/PgDn, but that is
      // an implementation detail, so navigation keys are excluded by
      // flag and control characters by code point before anything is
      // appended to the query. Ctrl/meta combos are not typed into it,
      // but they are still swallowed by the modal below. Ctrl+C keeps
      // working only because handleAppKey (tui-app.tsx) runs before
      // this handler ever sees the key.
      const isNavigationKey =
        key.tab ||
        key.return ||
        key.escape ||
        key.backspace ||
        key.delete ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.pageUp ||
        key.pageDown;
      if (
        input.length > 0 &&
        !key.ctrl &&
        !key.meta &&
        !isNavigationKey &&
        isPrintableFilterInput(input)
      ) {
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

  const steerUrl = state.llmPanel.externalCompatSteerUrl;
  if (steerUrl !== null) {
    // `y`/Enter accepts the steer: same two dispatches as the `n`
    // hotkey (flip to the Cloud pane, open the add wizard), except the
    // wizard opens on the OpenAI-compatible route with the refused URL
    // already filled in — Ollama URLs land on the Ollama preset.
    if (input.toLowerCase() === "y" || key.return) {
      dispatch({ type: "llm_external_compat_steer_closed" });
      dispatch({ type: "llm_mode_set", mode: "cloud" });
      dispatch({
        type: "providers_wizard_opened",
        wizard: wizardForOpenAiCompatUrl(steerUrl),
      });
      return true;
    }
    if (input.toLowerCase() === "n" || key.escape) {
      dispatch({ type: "llm_external_compat_steer_closed" });
      return true;
    }
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
 * True when every code point of the reported input is printable text.
 * Rejects C0 controls (below 0x20) and DEL (0x7f) so escape-sequence
 * fragments and raw control bytes can never land in a filter. Shared
 * with the Cloud pane's inline model filter so both text surfaces apply
 * the same discipline.
 */
export function isPrintableFilterInput(input: string): boolean {
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
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
