import type {
  FallbackLastSwitch,
  FallbackLinkRow,
} from "./fallback-panel-state.js";

/**
 * Reducer actions for the Fallback pane. The `*_requested` variants are
 * intents the orchestrator turns into a config write + a `fallback_refresh`
 * (mirroring the providers pane: intent actions cross the event bus into
 * `FallbackOrchestrator`, the resulting `fallback_refresh` re-mirrors
 * state). The rest are pure UI transitions handled by the reducer.
 */
export type FallbackPanelAction =
  /** Re-mirror the chain from config (orchestrator → reducer). */
  | {
      type: "fallback_refresh";
      links: readonly FallbackLinkRow[];
      addableProviderIds: readonly string[];
      appendLocal: boolean;
    }
  /** Move the link at `providerId` one slot up (−1) or down (+1). */
  | { type: "fallback_move_requested"; providerId: string; delta: -1 | 1 }
  /** Append `providerId` (a currently-addable provider) to the chain tail. */
  | { type: "fallback_add_requested"; providerId: string }
  /** Drop `providerId` from the chain. */
  | { type: "fallback_remove_requested"; providerId: string }
  /** Flip `llm.fallback.appendLocal`. */
  | { type: "fallback_append_local_toggle_requested" }
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
    action.type === "fallback_move_requested" ||
    action.type === "fallback_add_requested" ||
    action.type === "fallback_remove_requested" ||
    action.type === "fallback_append_local_toggle_requested" ||
    action.type === "fallback_add_picker_opened" ||
    action.type === "fallback_add_picker_closed" ||
    action.type === "fallback_add_picker_cursor_set" ||
    action.type === "fallback_status" ||
    action.type === "fallback_last_switch_set"
  );
}
