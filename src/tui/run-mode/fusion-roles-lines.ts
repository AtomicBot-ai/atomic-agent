import { FUSION_ROLES, type FusionRole } from "../../config/llm-run-mode-config.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";

/** One role as the terminal prints it: `review: deepseek/deepseek-v4.1 on openrouter`. */
export function describeFusionRole(rm: ResolvedRunMode, role: FusionRole): string {
  const entry = rm.roles?.byRole[role];
  if (entry === undefined) {
    return `${role}: not set, its tasks run on the workers' model${rm.workerModel ? ` ${rm.workerModel}` : ""}`;
  }
  const model = entry.model ?? "the provider's default model";
  return `${role}: ${model} on ${entry.providerId}`;
}

/**
 * Every role, one line each, for `/runmode roles`. Ends with how to set
 * one, so the list is also the way in (ATO-1754).
 */
export function describeFusionRoles(rm: ResolvedRunMode): string {
  return [
    "fusion roles:",
    ...FUSION_ROLES.map((role) => `  ${describeFusionRole(rm, role)}`),
    "Set one with /runmode role <role> <provider> [model]; several roles can share one provider with a model each. Clear it with /runmode role <role> off.",
  ].join("\n");
}
