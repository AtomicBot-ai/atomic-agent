import type { IntegrationRow } from "./integrations-panel-state.js";

/**
 * Reducer actions for the Integrations tab. The orchestrator and the
 * keyboard layer emit these; the reducer folds them into
 * `state.integrationsPanel`. The `integrations_` prefix lets the root
 * reducer narrow without a runtime tag dictionary.
 */
export type IntegrationsAction =
  | { type: "integrations_synced"; rows: readonly IntegrationRow[] }
  | { type: "integrations_moved"; delta: number }
  | { type: "integrations_field_moved"; delta: number }
  | { type: "integrations_opened" }
  | { type: "integrations_closed" }
  | { type: "integrations_edit_started" }
  | { type: "integrations_edit_changed"; value: string }
  | { type: "integrations_edit_cancelled" }
  | { type: "integrations_action_started" }
  | { type: "integrations_action_settled"; message?: string; error?: string }
  | { type: "integrations_message_cleared" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isIntegrationsAction(action: {
  type: string;
}): action is IntegrationsAction {
  return action.type.startsWith("integrations_");
}
