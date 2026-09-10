/**
 * Swarm: extra Telegram / Discord bots on one runtime. See AGENTS.md §"Swarm".
 */

export { SwarmRegistry } from "./swarm-registry.js";
export type {
  NewSwarmUnit,
  SwarmRegistryDeps,
  SwarmUnit,
  SwarmUnitKind,
  SwarmUnitPatch,
  SwarmUnitView,
} from "./swarm-registry.js";
export {
  readSwarmUnitToken,
  slugForUnit,
  tokenEnvForUnit,
  writeSwarmUnitToken,
  writeSwarmUnits,
} from "./swarm-settings.js";
export type { SwarmSettingsPaths } from "./swarm-settings.js";
