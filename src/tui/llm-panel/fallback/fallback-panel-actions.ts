import type {
  FallbackLastSwitch,
  FallbackLinkRow,
} from "./fallback-panel-state.js";

/**
 * Reducer actions for the Fallback pane — pure UI transitions plus the
 * mirror-refresh the orchestrator emits after a config write. The
 * side-effectful edits (move/add/remove/toggle appendLocal) are NOT
 * actions: dispatch feeds the React reducer only and never reaches the
 * event bus `FallbackOrchestrator` listens on, so they travel as
 * `TuiAppCallbacks.onFallback*` callbacks straight into the
 * orchestrator's public methods (see `fallback-key-bindings.ts` and
 * `tui-command.ts`), the same wiring as every other provider mutation.
 */
export type FallbackPanelAction =
  /** Re-mirror the chain from config (orchestrator → reducer). */
  | {
      type: "fallback_refresh";
      links: readonly FallbackLinkRow[];
      addableProviderIds: readonly string[];
      appendLocal: boolean;
    }
  /** Open the add-link picker (no-op when nothing is addable). */
  | { type: "fallback_add_picker_opened" }
  /** Close the add-link picker without adding. */
  | { type: "fallback_add_picker_closed" }
  /** Move the add-link picker cursor. */
  | { type: "fallback_add_picker_cursor_set"; cursor: number }
  /** Transient status/error line for the pane. */
  | { type: "fallback_status"; line: string | null }
  /** Record the last observed cross-provider switch (or clear it). */
  | { type: "fallback_last_switch_set"; lastSwitch: FallbackLastSwitch | null };

export function isFallbackPanelAction(
  action: { type: string },
): action is FallbackPanelAction {
  return (
    action.type === "fallback_refresh" ||
    action.type === "fallback_add_picker_opened" ||
    action.type === "fallback_add_picker_closed" ||
    action.type === "fallback_add_picker_cursor_set" ||
    action.type === "fallback_status" ||
    action.type === "fallback_last_switch_set"
  );
}
