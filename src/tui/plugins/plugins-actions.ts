import type { PluginOverview } from "../../plugins/plugin-overview.js";

/**
 * Reducer actions for the Plugins tab. The orchestrator and the keyboard
 * layer emit these; the reducer folds them into `state.pluginsPanel`. The
 * `plugins_` prefix lets the root reducer narrow without a tag dictionary.
 */
export type PluginsAction =
  | { type: "plugins_synced"; rows: readonly PluginOverview[] }
  | { type: "plugins_moved"; delta: number }
  | { type: "plugins_expand_toggled" }
  | { type: "plugins_collapsed" }
  | { type: "plugins_remove_started" }
  | { type: "plugins_allow_code_started" }
  | { type: "plugins_cancelled" }
  | { type: "plugins_action_started" }
  | { type: "plugins_action_settled"; message?: string; error?: string }
  | { type: "plugins_message_cleared" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isPluginsAction(action: { type: string }): action is PluginsAction {
  return action.type.startsWith("plugins_");
}
