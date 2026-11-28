/**
 * ATO-1754: the route behind Settings › Models › Fusion › "Models by role"
 * (renderer/fusion-roles.js).
 *
 *   cli:fusionRole  { role, providerId: string | null, model?: string }
 *
 * One hold of the config lock: read, plan (fusion-roles.ts), write with
 * `--expect-sha256`; a write that lost to the terminal or another window is
 * read and planned again (agent-cli.ts, ATO-416), as the workers' reasoning
 * level does (fusion-reasoning-ipc.ts). The agent reads the roles from its
 * cached config, so the window says the change applies after Restart Agent
 * Runtime; nothing restarts from here.
 */

import { ipcMain } from "electron";

import { CONFIG_CHANGED_ELSEWHERE, rewriteWholeConfig } from "./agent-cli.js";
import { parseFusionRoleRequest, planFusionRole, type FusionRoleName, type FusionRoleState } from "./fusion-roles.js";

export type FusionRoleAnswer =
  | { ok: true; changed: boolean; role: FusionRoleName; after: FusionRoleState }
  | { ok: false; error: string; refusal?: string };

export async function setFusionRole(payload: unknown): Promise<FusionRoleAnswer> {
  const req = parseFusionRoleRequest(payload);
  if (req === null) return { ok: false, error: "the role must be plan, build, review, explore or utility, with a provider id or none" };
  const res = await rewriteWholeConfig((cfg) => planFusionRole(cfg, req));
  const v = res.verdict;
  if (v?.refusal) return { ok: false, error: v.refusal, refusal: v.refusal };
  if (!res.ok) return { ok: false, error: res.error ?? CONFIG_CHANGED_ELSEWHERE };
  return { ok: true, changed: res.changed, role: req.role, after: v ? v.after : { providerId: null, model: null } };
}

export function wireFusionRolesIpc(): void {
  ipcMain.handle("cli:fusionRole", (_event, payload: unknown) => setFusionRole(payload));
}
