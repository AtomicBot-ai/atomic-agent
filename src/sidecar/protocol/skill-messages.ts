/**
 * Request/response payload shapes for the `skill.*` commands. See SIDECAR.md
 * §4.7. Enable/disable/install/uninstall all call `refreshSkills` internally,
 * which fires the `skill.registry_updated` event through the runtime handler.
 */
import type { SkillEntry } from "../../runtime-api/index.js";

export interface SkillListPayload {
  [key: string]: never;
}
export interface SkillListResult {
  skills: SkillEntry[];
}

export interface SkillEnablePayload {
  name: string;
}
export interface SkillEnableResult {
  ok: true;
}

export interface SkillDisablePayload {
  name: string;
}
export interface SkillDisableResult {
  ok: true;
}

export interface SkillInstallPayload {
  sourcePath: string;
  force?: boolean;
}
export interface SkillInstallResult {
  name: string;
  installedAt: string;
}

export interface SkillUninstallPayload {
  name: string;
}
export interface SkillUninstallResult {
  removed: boolean;
}
