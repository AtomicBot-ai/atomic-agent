/**
 * Which leg of a fusion pair serves one inference.
 *
 * `orchestrator` is the cloud provider (plans, reconciles, synthesises);
 * `executor` is the local provider (mechanical continuation steps).
 */
export type RoutingRole = "orchestrator" | "executor";

/**
 * Score margin applied against the direction of travel so a step near
 * the cutoff does not flip the provider back and forth.
 *
 * This is load-bearing, not cosmetic. llama-server reuses its KV cache
 * by longest common prefix, so every return to the local leg after a
 * cloud step has to reprocess the tail that grew in between. Hysteresis
 * produces RUNS of consecutive local steps, which is what makes the
 * local cache pay for itself.
 */
export const ROUTING_HYSTERESIS = 10;

export interface RoutingDecisionArgs {
  /** 0-100 from `computeStepComplexity`. */
  score: number;
  /** 0-100 operator dial from `llm.runMode.fusion.cloudShare`. */
  cloudShare: number;
  /** 0-based step index inside the turn. */
  stepIndex: number;
  /** Role the previous step of this session resolved to, if any. */
  previousRole?: RoutingRole | null;
}

/**
 * Map a complexity score onto a fusion leg.
 *
 * The dial sets a cutoff at `100 - cloudShare`: a bigger share means a
 * lower bar for reaching the cloud. It is a DIAL, NOT A QUOTA — it does
 * not promise that N% of steps go to the cloud, and it must not be
 * turned into a running-counter scheduler, which would necessarily send
 * some trivial steps to the cloud and keep some hard ones local.
 *
 * Two rules override the score:
 * - `cloudShare` 0 / 100 short-circuit to pure local / pure cloud, so
 *   the extremes are exact rather than merely very likely.
 * - Step 0 always orchestrates (when the cloud leg is in play at all):
 *   it forms the turn's plan and picks the first tool batch, which
 *   determines everything downstream. It is exactly one call per turn,
 *   so the cost is bounded and predictable.
 */
export function decideRoutingRole(args: RoutingDecisionArgs): RoutingRole {
  if (args.cloudShare <= 0) return "executor";
  if (args.cloudShare >= 100) return "orchestrator";
  if (args.stepIndex === 0) return "orchestrator";

  const cutoff = 100 - args.cloudShare;
  const margin =
    args.previousRole === "executor"
      ? ROUTING_HYSTERESIS
      : args.previousRole === "orchestrator"
        ? -ROUTING_HYSTERESIS
        : 0;
  return args.score >= cutoff + margin ? "orchestrator" : "executor";
}
