/**
 * Swarm tab — every bot on this runtime, with add / edit / pair / remove
 * for the extra units. See AGENTS.md §"Swarm".
 */

export { SwarmOrchestrator } from "./swarm-orchestrator.js";
export type { SwarmAddInput } from "./swarm-orchestrator.js";
export { handleSwarmTabKey } from "./swarm-key-bindings.js";
export type { SwarmTabKeyContext } from "./swarm-key-bindings.js";
export { reduceSwarmAction } from "./swarm-panel-reducer.js";
export { isSwarmAction } from "./swarm-actions.js";
export type { SwarmAction } from "./swarm-actions.js";
export {
  SWARM_ADD_STEPS,
  SWARM_EDIT_FIELDS,
  aliveSwarmCount,
  createInitialSwarmPanelState,
  selectedSwarmRow,
} from "./swarm-panel-state.js";
export type {
  SwarmAddForm,
  SwarmEditField,
  SwarmKind,
  SwarmPanelMode,
  SwarmPanelState,
  SwarmRow,
} from "./swarm-panel-state.js";
export { SwarmPanel } from "./components/swarm-panel.js";
export { ZerglingStrip } from "./zergling-strip.js";
