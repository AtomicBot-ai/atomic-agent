import type { ResolvedRunMode } from "./resolve-run-mode.js";

/**
 * The model an unpinned request to `providerId` asks for while Fusion
 * runs (ATO-1560): the orchestrator's chosen model on the orchestrator
 * leg, nothing anywhere else.
 *
 * The orchestrator's turns go through the fallback chain rather than a
 * pin, so they cannot carry a per-turn model the way a worker turn does.
 * The seam asks this for each link it tries instead: the orchestrator
 * leg answers with `orchestratorModel`, a fallover to another link gets
 * that link's own model. Workers on the same provider always name their
 * own (`workerTurnModel`), so they never pick this up.
 */
export function fusionLinkModel(
  runMode: Pick<ResolvedRunMode, "effective" | "orchestratorProviderId" | "orchestratorTurnModel">,
  providerId: string,
): string | undefined {
  if (runMode.effective !== "fusion") return undefined;
  if (runMode.orchestratorProviderId !== providerId) return undefined;
  return runMode.orchestratorTurnModel;
}
