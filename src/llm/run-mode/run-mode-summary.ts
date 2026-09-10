import { describeRunModeDegradation } from "./run-mode-degradation.js";
import type { ResolvedRunMode } from "./resolve-run-mode.js";

/** Capitalised mode word for operator-facing lines. */
export function runModeLabel(mode: ResolvedRunMode["effective"]): string {
  return mode === "fusion" ? "Fusion" : mode === "cloud" ? "Cloud" : "Local";
}

/**
 * One operator-facing line describing what the run mode resolves to —
 * the body of `/runmode status`. Says when the stored and the effective
 * mode disagree, because that is the one state a reader cannot infer
 * from the chip alone.
 */
export function describeRunMode(rm: ResolvedRunMode): string {
  const parts: string[] = [];
  if (rm.effective === "fusion") {
    parts.push(
      `Fusion — orchestrator ${rm.orchestratorProviderId}${
        rm.orchestratorModel ? ` (${rm.orchestratorModel})` : ""
      }, ${rm.workers} worker${rm.workers === 1 ? "" : "s"} on ${rm.workerProviderId}${
        rm.workerModel ? ` (${rm.workerModel})` : ""
      }`,
    );
  } else {
    parts.push(
      `${runModeLabel(rm.effective)} — active provider ${rm.primaryProviderId}`,
    );
  }
  if (rm.degraded) {
    parts.push(describeRunModeDegradation(rm.degraded));
  } else if (rm.stored !== null && rm.stored !== rm.effective) {
    parts.push(
      `stored ${rm.stored}, effective ${rm.effective} — the ${
        rm.stored === "fusion" ? "orchestrator" : rm.stored
      } provider is not the active one; pick the mode again to re-apply`,
    );
  }
  return parts.join(". ");
}
