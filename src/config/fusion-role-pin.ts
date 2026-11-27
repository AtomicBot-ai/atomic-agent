import {
  type FusionRole,
  type UserLlmFusionConfig,
} from "./llm-run-mode-config.js";

/**
 * What a role is set to: a configured provider and, optionally, the
 * model it asks that provider for (`roleModels`). `null` clears the role,
 * so its tasks run on the worker leg again.
 */
export type FusionRolePin = { providerId: string; model?: string } | null;

/**
 * `fusion` with one role pinned, repinned or cleared. Pure, so the
 * terminal command and its tests share it. A role moved to another
 * provider without a model loses its old model name: that name belonged
 * to the old provider, as `repinFusionLegs` does for the two legs. The
 * same provider with no model keeps nothing either: the person picked
 * the provider's own model. Empty maps are left out of the result.
 */
export function withFusionRolePin(
  fusion: UserLlmFusionConfig | undefined,
  role: FusionRole,
  pin: FusionRolePin,
): UserLlmFusionConfig {
  const { roles, roleModels, ...rest } = fusion ?? {};
  const nextRoles: Partial<Record<FusionRole, string>> = { ...roles };
  const nextModels: Partial<Record<FusionRole, string>> = { ...roleModels };
  delete nextRoles[role];
  delete nextModels[role];
  if (pin !== null) {
    nextRoles[role] = pin.providerId;
    const model = pin.model?.trim();
    if (model !== undefined && model.length > 0) nextModels[role] = model;
  }
  return {
    ...rest,
    ...(Object.keys(nextRoles).length > 0 ? { roles: nextRoles } : {}),
    ...(Object.keys(nextModels).length > 0 ? { roleModels: nextModels } : {}),
  };
}
