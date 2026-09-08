/**
 * TUI slice for the Integrations tab. See AGENTS.md §"Integrations hub".
 */

export {
  createInitialIntegrationsPanelState,
  selectedField,
  selectedRow,
} from "./integrations-panel-state.js";
export type {
  IntegrationFieldRow,
  IntegrationRow,
  IntegrationsPanelMode,
  IntegrationsPanelState,
} from "./integrations-panel-state.js";
export { isIntegrationsAction } from "./integrations-actions.js";
export type { IntegrationsAction } from "./integrations-actions.js";
export { reduceIntegrationsAction } from "./integrations-panel-reducer.js";
export { handleIntegrationsTabKey } from "./integrations-key-bindings.js";
export { IntegrationsOrchestrator } from "./integrations-orchestrator.js";
