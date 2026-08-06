import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import { handleProvidersWizardKey } from "./providers-wizard-key-bindings.js";
import { isCloudProviderKind } from "./providers-orchestrator.js";

export interface ProvidersTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

export function handleProvidersTabKey(
  input: string,
  key: Key,
  ctx: ProvidersTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "providers") {
    return false;
  }
  const panel = state.providersPanel;

  if (panel.wizard !== null) {
    const result = handleProvidersWizardKey(input, key, panel.wizard);
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

  if (panel.removeConfirm !== null) {
    if (panel.busy) return true;
    if (key.escape || input === "n" || input === "N") {
      dispatch({ type: "providers_remove_closed" });
      return true;
    }
    if (input === "y" || input === "Y" || key.return) {
      dispatch({ type: "providers_remove_confirm_started" });
      callbacks.onProvidersRemove?.(panel.removeConfirm.id);
      return true;
    }
    return true;
  }

  if (key.downArrow || input === "j") {
    dispatch({ type: "providers_cursor_down" });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "providers_cursor_up" });
    return true;
  }
  if (input === "r") {
    callbacks.onProvidersTabRefresh?.();
    return true;
  }
  if (input === "n") {
    dispatch({ type: "providers_catalog_refresh_requested" });
    dispatch({
      type: "providers_wizard_opened",
      wizard: createProvidersWizardState("add"),
    });
    return true;
  }
  if (input === "c") {
    const row = panel.rows[panel.cursor];
    if (row && isCloudProviderKind(row.kind)) {
      dispatch({ type: "providers_catalog_refresh_requested" });
      dispatch({
        type: "providers_wizard_opened",
        wizard: createProvidersWizardState("configure", {
          providerId: row.id,
          kind: row.kind,
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        }),
      });
    }
    return true;
  }
  if (input === "t") {
    const row = panel.rows[panel.cursor];
    if (row) {
      callbacks.onProvidersSetActiveText?.(row.id);
    }
    return true;
  }
  if (input === "e") {
    const row = panel.rows[panel.cursor];
    if (row) {
      callbacks.onProvidersSetActiveEmbedding?.(row.id);
    }
    return true;
  }
  if (input === "d" || key.delete || key.backspace) {
    const row = panel.rows[panel.cursor];
    if (row && row.id !== "local-llama") {
      dispatch({ type: "providers_remove_opened", id: row.id });
    }
    return true;
  }
  return false;
}
