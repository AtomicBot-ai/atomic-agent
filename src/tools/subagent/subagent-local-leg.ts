import { LocalLegHealth } from "../fusion/local-leg-health.js";
import type { FusionWorkerRunnerDepsExtras } from "../fusion/worker-runner-core.js";

/**
 * What `subagent.run` checks and renews a local leg with after a
 * subagent on it was cut off (ATO-2430, issue #490). The same seams
 * `fusion.delegate` gets (ATO-917, ATO-1357, ATO-1318); they are Fusion
 * runner add-ons, so the tool runs its workers on the full runner.
 * Every one is optional: absent (tests, embedders, a cloud leg) nothing
 * is checked or renewed.
 */
export type SubagentLocalLegDeps = Pick<
  FusionWorkerRunnerDepsExtras,
  | "localLegHealth"
  | "probeLocalHealth"
  | "probeLocalHealthFor"
  | "renewLocalTransport"
  | "probeSlotOccupancy"
>;

/**
 * One per tool, as `fusion.delegate` keeps its own: a local server left
 * wedged by one call's cut-off subagent is still wedged for the next
 * call, which is asked about it before it is sent.
 */
export function subagentLocalLegHealth(deps: SubagentLocalLegDeps): LocalLegHealth {
  return deps.localLegHealth ?? new LocalLegHealth();
}
