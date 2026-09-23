import { DEFAULT_FUSION_CLOUD_WORKERS } from "../../config/llm-run-mode-config.js";
import { describeRunModeDegradation } from "./run-mode-degradation.js";
import type { ResolvedRunMode } from "./resolve-run-mode.js";

/** Capitalised mode word for operator-facing lines. */
export function runModeLabel(mode: ResolvedRunMode["effective"]): string {
  return mode === "fusion" ? "Fusion" : mode === "cloud" ? "Cloud" : "Local";
}

/**
 * What actually bounds a fan-out, for the status line: the worker leg
 * and — for a local one — its request slots when known. The same
 * facts `resolveFusionMachineFacts` states to the model.
 */
export interface RunModeWorkerFacts {
  workerLeg: "local" | "cloud" | null;
  workerSlots: number | null;
}

/**
 * "workers: up to N local slots" / "up to N cloud workers" — what will
 * run, as opposed to `workers`, which is only the default for a call
 * that names no width (and read "2 workers" next to a 5-slot server).
 */
function describeWorkerCapacity(
  rm: ResolvedRunMode,
  facts: RunModeWorkerFacts,
): string | null {
  if (facts.workerLeg === "cloud") {
    const cap = rm.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS;
    return `workers: up to ${cap} cloud worker${cap === 1 ? "" : "s"}`;
  }
  if (facts.workerLeg === "local") {
    return facts.workerSlots === null
      ? "workers: local slots not observed yet"
      : `workers: up to ${facts.workerSlots} local slot${facts.workerSlots === 1 ? "" : "s"}`;
  }
  return null;
}

/**
 * One operator-facing line describing what the run mode resolves to —
 * the body of `/runmode status`. Says when the stored and the effective
 * mode disagree, because that is the one state a reader cannot infer
 * from the chip alone. With `facts`, also says what will run.
 */
export function describeRunMode(
  rm: ResolvedRunMode,
  facts?: RunModeWorkerFacts,
): string {
  const parts: string[] = [];
  if (rm.effective === "fusion") {
    const capacity = facts === undefined ? null : describeWorkerCapacity(rm, facts);
    parts.push(
      `Fusion — orchestrator ${rm.orchestratorProviderId}${
        rm.orchestratorModel ? ` (${rm.orchestratorModel})` : ""
      }, ${rm.workers} worker${rm.workers === 1 ? "" : "s"} on ${rm.workerProviderId}${
        rm.workerModel ? ` (${rm.workerModel})` : ""
      }${capacity === null ? "" : `; ${capacity}`}`,
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
