import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { selectedSwarmRow } from "./swarm-panel-state.js";

export interface SwarmTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Swarm tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true` when
 * the key was consumed so the editor echo is suppressed.
 *
 * List:   ↑/↓ or j/k move · a add · e edit · enter/x on/off · p pair
 *         s restart · d remove · r refresh
 * Add:    kind step: ←/→ or t/d pick · every other step types ·
 *         enter next/submit · backspace erase · esc back
 * Edit:   ↑/↓ field · enter/e type a new value · enter save · esc back
 * Remove: y confirm · anything else cancels
 *
 * Typing modes swallow the whole keyboard on purpose: a token contains
 * characters that are bindings everywhere else, and a paste that
 * silently triggered "remove" halfway through would be destructive.
 */
export function handleSwarmTabKey(input: string, key: Key, ctx: SwarmTabKeyContext): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "swarm") return false;
  const panel = state.swarmPanel;
  if (panel.busy) return true;

  if (panel.mode === "add") {
    const { form } = panel;
    if (key.escape) {
      dispatch({ type: "swarm_form_back" });
      return true;
    }
    if (form.step === "kind") {
      if (key.leftArrow || key.rightArrow || key.tab) {
        dispatch({
          type: "swarm_form_kind_set",
          kind: form.kind === "telegram" ? "discord" : "telegram",
        });
        return true;
      }
      if (input === "t") {
        dispatch({ type: "swarm_form_kind_set", kind: "telegram" });
        return true;
      }
      if (input === "d") {
        dispatch({ type: "swarm_form_kind_set", kind: "discord" });
        return true;
      }
      if (key.return) {
        dispatch({ type: "swarm_form_next" });
        return true;
      }
      return true;
    }
    if (key.return) {
      if (form.step === "owner") {
        void callbacks.onSwarmAddRequested?.({
          kind: form.kind,
          label: form.label,
          role: form.role,
          token: form.token,
          ownerUserId: form.owner,
        });
        return true;
      }
      dispatch({ type: "swarm_form_next" });
      return true;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: "swarm_form_backspace" });
      return true;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      dispatch({ type: "swarm_form_typed", text: input });
      return true;
    }
    return true;
  }

  if (panel.mode === "edit") {
    const row = selectedSwarmRow(panel);
    if (panel.editBuffer !== null) {
      if (key.escape) {
        dispatch({ type: "swarm_cancelled" });
        return true;
      }
      if (key.return) {
        if (row) {
          void callbacks.onSwarmFieldSaveRequested?.(row.id, panel.editField, panel.editBuffer);
        }
        return true;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "swarm_edit_backspace" });
        return true;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        dispatch({ type: "swarm_edit_typed", text: input });
        return true;
      }
      return true;
    }
    if (key.escape) {
      dispatch({ type: "swarm_cancelled" });
      return true;
    }
    if (key.upArrow || input === "k") {
      dispatch({ type: "swarm_edit_field_moved", delta: -1 });
      return true;
    }
    if (key.downArrow || input === "j") {
      dispatch({ type: "swarm_edit_field_moved", delta: 1 });
      return true;
    }
    if (key.return || input === "e") {
      dispatch({ type: "swarm_edit_typing_started" });
      return true;
    }
    return false;
  }

  if (panel.mode === "remove") {
    const row = selectedSwarmRow(panel);
    if (input === "y" && row && !row.primary) {
      void callbacks.onSwarmRemoveRequested?.(row.id);
      return true;
    }
    dispatch({ type: "swarm_cancelled" });
    return true;
  }

  // List mode.
  if (key.upArrow || input === "k") {
    dispatch({ type: "swarm_moved", delta: -1 });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "swarm_moved", delta: 1 });
    return true;
  }
  if (input === "a") {
    dispatch({ type: "swarm_add_started" });
    return true;
  }
  if (input === "r") {
    callbacks.onSwarmRefreshRequested?.();
    return true;
  }
  const row = selectedSwarmRow(panel);
  if (!row) return false;
  if (input === "e") {
    dispatch({ type: "swarm_edit_started" });
    return true;
  }
  if (input === "d") {
    dispatch({ type: "swarm_remove_started" });
    return true;
  }
  if (key.return || input === "x") {
    void callbacks.onSwarmToggleRequested?.(row.id);
    return true;
  }
  if (input === "p") {
    void callbacks.onSwarmPairRequested?.(row.id);
    return true;
  }
  if (input === "s") {
    void callbacks.onSwarmRestartRequested?.(row.id);
    return true;
  }
  return false;
}
