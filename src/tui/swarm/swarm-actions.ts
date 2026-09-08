import type { SwarmKind, SwarmRow } from "./swarm-panel-state.js";

/**
 * Reducer actions for the Swarm tab. The orchestrator and the keyboard
 * layer emit these; the reducer folds them into `state.swarmPanel`. The
 * `swarm_` prefix lets the root reducer narrow without a tag dictionary.
 */
export type SwarmAction =
  | { type: "swarm_synced"; rows: readonly SwarmRow[] }
  | { type: "swarm_moved"; delta: number }
  | { type: "swarm_add_started" }
  | { type: "swarm_form_kind_set"; kind: SwarmKind }
  | { type: "swarm_form_changed"; value: string }
  | { type: "swarm_form_next" }
  | { type: "swarm_form_back" }
  | { type: "swarm_edit_started" }
  | { type: "swarm_edit_field_moved"; delta: number }
  | { type: "swarm_edit_typing_started" }
  | { type: "swarm_edit_changed"; value: string }
  | { type: "swarm_remove_started" }
  | { type: "swarm_cancelled" }
  | { type: "swarm_action_started" }
  | { type: "swarm_action_settled"; message?: string; error?: string }
  | { type: "swarm_message_cleared" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isSwarmAction(action: { type: string }): action is SwarmAction {
  return action.type.startsWith("swarm_");
}
