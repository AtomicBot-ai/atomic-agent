import type { ToolRegistry } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { SkillRecord } from "../../skills/skill-loader.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { buildSkillViewTool } from "./skill-view.js";
import { buildSkillRunScriptTool } from "./skill-run-script.js";

export { buildSkillViewTool } from "./skill-view.js";
export { buildSkillRunScriptTool } from "./skill-run-script.js";
export type { SkillRunScriptToolOptions } from "./skill-run-script.js";
export {
  rawTargetPaths,
  SKILL_EDIT_TOOLS,
  skillNameForPath,
  skillTargets,
  trackSkillEdits,
} from "./skill-edit-tracker.js";
export type { TrackSkillEditsOptions } from "./skill-edit-tracker.js";

export function registerSkillTools(
  registry: ToolRegistry,
  skillRegistry: SkillRegistry,
  dangerous: DangerousToolOptions,
  /** `tools.shell.envPassthrough`; see `SkillRunScriptToolOptions`. */
  envPassthrough?: readonly string[],
  /** Data folder for plugin code consent; see `SkillRunScriptToolOptions.pluginsStateDir`. */
  pluginsStateDir?: string,
  /** Usage ledger hook for both tools (ATO-580); absent counts nothing. */
  onSkillUsed?: (record: SkillRecord) => void,
): void {
  registry.register(buildSkillViewTool(skillRegistry, onSkillUsed));
  registry.register(
    buildSkillRunScriptTool(skillRegistry, {
      ...dangerous,
      ...(envPassthrough !== undefined ? { envPassthrough } : {}),
      ...(pluginsStateDir !== undefined ? { pluginsStateDir } : {}),
      ...(onSkillUsed !== undefined ? { onSkillUsed } : {}),
    }),
  );
}
