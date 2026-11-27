/**
 * ATO-1754: Settings › Models › Fusion › "Models by role".
 *
 * The agent reads `llm.runMode.fusion.roles` (role → configured provider
 * id) and, since the core change it stacks on, `roleModels` (role → model
 * name on that provider), so several roles can share one provider entry
 * with a model each. A role with no provider runs on the worker leg; a
 * role with a provider and no model runs the workers' model on the
 * workers' provider, the planner's model on the planner's provider, and
 * the provider's default model elsewhere;
 * a llama-server entry serves the model it loaded and the agent ignores a
 * name there (src/llm/run-mode/resolve-run-mode.ts).
 *
 * The pure half: what the window may ask for, and the plan that pins,
 * repins or clears one role on a config read under the config lock. The
 * write itself (rewriteWholeConfig: one read, the plan, one
 * compare-and-swap write, ATO-416) is in fusion-roles-ipc.ts. The rules
 * mirror src/config/fusion-role-pin.ts `withFusionRolePin`, which the
 * terminal's `/runmode role` uses: a role moved to another provider
 * without a model loses its old model, clearing removes both, and no
 * empty map is written. Other roles, including ones a newer build added,
 * and every other fusion key stay as they were.
 */

export type FusionRoleName = "plan" | "build" | "review" | "explore" | "utility";

export const FUSION_ROLE_NAMES: readonly FusionRoleName[] = ["plan", "build", "review", "explore", "utility"];

/** What a role is set to; null runs it on the workers' model again. */
export type FusionRolePin = { providerId: string; model?: string } | null;

export interface FusionRoleRequest {
  role: FusionRoleName;
  pin: FusionRolePin;
}

/** A role as the file holds it: its provider and model, each null when unset. */
export interface FusionRoleState {
  providerId: string | null;
  model: string | null;
}

/** The slice of the config the plan reads and writes. */
export interface FusionRolesConfig {
  llm?: {
    providers?: ReadonlyArray<{ id?: unknown; kind?: unknown }>;
    runMode?: { fusion?: Record<string, unknown> };
  };
}

export interface FusionRoleVerdict {
  write: boolean;
  before: FusionRoleState;
  after: FusionRoleState;
  refusal?: string;
}

const LOCAL_KIND = "llama-server";

export function isFusionRoleName(v: unknown): v is FusionRoleName {
  return typeof v === "string" && (FUSION_ROLE_NAMES as readonly string[]).includes(v);
}

/**
 * The IPC argument `{ role, providerId, model? }` as a request, or null.
 * `providerId` null or "" clears the role; a blank model is no model.
 */
export function parseFusionRoleRequest(raw: unknown): FusionRoleRequest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { role, providerId, model } = raw as Record<string, unknown>;
  if (!isFusionRoleName(role)) return null;
  if (providerId === null || providerId === undefined || providerId === "") return { role, pin: null };
  if (typeof providerId !== "string") return null;
  if (model !== undefined && model !== null && typeof model !== "string") return null;
  const name = typeof model === "string" ? model.trim() : "";
  return { role, pin: name ? { providerId, model: name } : { providerId } };
}

function plainMap(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** The role's provider and model in a fusion block. */
export function fusionRoleState(fusion: Record<string, unknown> | undefined, role: FusionRoleName): FusionRoleState {
  const p = plainMap(fusion?.["roles"])[role];
  const m = plainMap(fusion?.["roleModels"])[role];
  const providerId = typeof p === "string" && p ? p : null;
  return { providerId, model: providerId && typeof m === "string" && m ? m : null };
}

/**
 * `fusion` with one role pinned, repinned or cleared (a copy). As
 * `withFusionRolePin` in the agent: the role's old provider and model go
 * first, so a new provider without a model keeps no old name, and an
 * empty `roles` or `roleModels` is left out.
 */
export function withFusionRolePin(
  fusion: Record<string, unknown> | undefined,
  role: FusionRoleName,
  pin: FusionRolePin,
): Record<string, unknown> {
  const base: Record<string, unknown> = fusion ?? {};
  const { roles, roleModels, ...rest } = base;
  const nextRoles = plainMap(roles);
  const nextModels = plainMap(roleModels);
  delete nextRoles[role];
  delete nextModels[role];
  if (pin !== null) {
    nextRoles[role] = pin.providerId;
    const model = pin.model?.trim();
    if (model) nextModels[role] = model;
  }
  return {
    ...rest,
    ...(Object.keys(nextRoles).length > 0 ? { roles: nextRoles } : {}),
    ...(Object.keys(nextModels).length > 0 ? { roleModels: nextModels } : {}),
  };
}

/**
 * Pin, repin or clear one role on `cfg` (mutated, as the run-mode
 * planners do). A provider that is not configured is refused rather
 * than written: the agent refuses a pin to an unknown id and would not
 * read the file. A model name on a llama-server entry is not written,
 * since the agent would not use it. Nothing moves when the role already
 * says the same.
 */
export function planFusionRole(cfg: FusionRolesConfig, req: FusionRoleRequest): FusionRoleVerdict {
  const fusionNow = cfg.llm?.runMode?.fusion;
  const before = fusionRoleState(fusionNow, req.role);
  if (!cfg.llm) {
    return { write: false, before, after: before, refusal: "No provider is set up yet. Add one in Settings › Models first." };
  }
  let pin = req.pin;
  if (pin !== null) {
    const providerId = pin.providerId;
    const providers: ReadonlyArray<{ id?: unknown; kind?: unknown }> = cfg.llm.providers ?? [];
    const entry = providers.find((p) => p && p.id === providerId);
    if (!entry) {
      return { write: false, before, after: before, refusal: "That provider is no longer set up. Pick another one." };
    }
    if (entry.kind === LOCAL_KIND) pin = { providerId };
  }
  const after: FusionRoleState = pin === null
    ? { providerId: null, model: null }
    : { providerId: pin.providerId, model: pin.model?.trim() || null };
  if (before.providerId === after.providerId && before.model === after.model) return { write: false, before, after };
  const fusion = withFusionRolePin(fusionNow, req.role, pin);
  const llm = cfg.llm;
  cfg.llm = { ...llm, runMode: { ...llm.runMode, fusion } };
  return { write: true, before, after };
}
