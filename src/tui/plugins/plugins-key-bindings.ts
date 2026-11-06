import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { selectedPluginsLine } from "./plugins-panel-state.js";

export interface PluginsTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Plugins tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true` when
 * the key was consumed so the editor echo is suppressed.
 *
 * List:  ↑/↓ or j/k move · enter/→ open or close a plugin's parts
 *        (on a part: switch it) · ← close · space/x switch on/off
 *        c allow code (asks) or stop it · d remove (asks) · r refresh
 * Ask:   y confirms · anything else cancels
 */
export function handlePluginsTabKey(
  input: string,
  key: Key,
  ctx: PluginsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "plugins") return false;
  const panel = state.pluginsPanel;
  if (panel.busy) return true;
  const line = selectedPluginsLine(panel);

  if (panel.mode === "remove" || panel.mode === "allow-code") {
    if (input === "y" && line?.kind === "plugin") {
      if (panel.mode === "remove") void callbacks.onPluginRemoveRequested?.(line.plugin.name);
      else void callbacks.onPluginCodeTrustRequested?.(line.plugin.name, true);
      return true;
    }
    dispatch({ type: "plugins_cancelled" });
    return true;
  }

  if (key.upArrow || input === "k") {
    dispatch({ type: "plugins_moved", delta: -1 });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "plugins_moved", delta: 1 });
    return true;
  }
  if (input === "r") {
    callbacks.onPluginsRefreshRequested?.();
    return true;
  }
  if (key.leftArrow) {
    dispatch({ type: "plugins_collapsed" });
    return true;
  }
  if (!line) return false;

  if (key.return || key.rightArrow) {
    if (line.kind === "plugin") {
      dispatch({ type: "plugins_expand_toggled" });
      return true;
    }
    if (key.rightArrow) return true;
    void callbacks.onPluginPartToggleRequested?.(line.plugin.name, line.part.id, !line.part.enabled);
    return true;
  }
  if (input === " " || input === "x") {
    if (line.kind === "plugin") {
      void callbacks.onPluginToggleRequested?.(line.plugin.name, !line.plugin.enabled);
    } else {
      void callbacks.onPluginPartToggleRequested?.(line.plugin.name, line.part.id, !line.part.enabled);
    }
    return true;
  }
  if (input === "c") {
    if (!line.plugin.runsCode) return true;
    if (line.plugin.trust === "code-allowed") {
      void callbacks.onPluginCodeTrustRequested?.(line.plugin.name, false);
      return true;
    }
    if (line.kind !== "plugin") return true;
    dispatch({ type: "plugins_allow_code_started" });
    return true;
  }
  if (input === "d") {
    if (line.kind === "plugin") dispatch({ type: "plugins_remove_started" });
    return true;
  }
  return false;
}
