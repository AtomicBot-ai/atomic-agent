import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { selectedField, selectedRow } from "./integrations-panel-state.js";

export interface IntegrationsTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Integrations tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true` when
 * the key was consumed so the editor echo is suppressed.
 *
 * List mode:   ↑/↓ or j/k move · Enter opens · r refreshes
 * Detail mode: ↑/↓ move between fields · e edits · d clears · Esc back
 * Edit mode:   every printable key appends · Enter saves · Esc cancels
 *
 * Edit mode swallows the whole keyboard on purpose: an API key contains
 * characters that are bindings everywhere else (`d`, `e`, `r`), and a
 * paste that silently triggered "clear field" halfway through would be
 * both baffling and destructive.
 */
export function handleIntegrationsTabKey(
  input: string,
  key: Key,
  ctx: IntegrationsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "integrations") {
    return false;
  }
  const panel = state.integrationsPanel;
  if (panel.busy) return true;

  if (panel.mode === "edit") {
    if (key.escape) {
      dispatch({ type: "integrations_edit_cancelled" });
      return true;
    }
    if (key.return) {
      const row = selectedRow(panel);
      const field = selectedField(panel);
      if (row && field) {
        void callbacks.onIntegrationFieldSaveRequested?.(
          row.id,
          field.key,
          panel.editBuffer,
        );
      }
      return true;
    }
    if (key.backspace || key.delete) {
      dispatch({
        type: "integrations_edit_changed",
        value: panel.editBuffer.slice(0, -1),
      });
      return true;
    }
    // Ignore the control keys Ink reports alongside an empty `input`;
    // everything else is literal key material.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      dispatch({
        type: "integrations_edit_changed",
        value: panel.editBuffer + input,
      });
      return true;
    }
    return true;
  }

  if (panel.mode === "detail") {
    if (key.escape) {
      dispatch({ type: "integrations_closed" });
      return true;
    }
    if (key.upArrow || input === "k") {
      dispatch({ type: "integrations_field_moved", delta: -1 });
      return true;
    }
    if (key.downArrow || input === "j") {
      dispatch({ type: "integrations_field_moved", delta: 1 });
      return true;
    }
    if (input === "e") {
      dispatch({ type: "integrations_edit_started" });
      return true;
    }
    if (input === "d") {
      const row = selectedRow(panel);
      const field = selectedField(panel);
      if (row && field && field.present) {
        void callbacks.onIntegrationFieldClearRequested?.(row.id, field.key);
      }
      return true;
    }
    return false;
  }

  if (key.upArrow || input === "k") {
    dispatch({ type: "integrations_moved", delta: -1 });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "integrations_moved", delta: 1 });
    return true;
  }
  if (key.return) {
    dispatch({ type: "integrations_opened" });
    return true;
  }
  if (input === "r") {
    callbacks.onIntegrationsRefreshRequested?.();
    return true;
  }
  return false;
}
