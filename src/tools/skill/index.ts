import type { ToolRegistry } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { buildSkillViewTool } from "./skill-view.js";
import { buildSkillRunScriptTool } from "./skill-run-script.js";

export { buildSkillViewTool } from "./skill-view.js";
export { buildSkillRunScriptTool } from "./skill-run-script.js";

export function registerSkillTools(
  registry: ToolRegistry,
  skillRegistry: SkillRegistry,
  dangerous: DangerousToolOptions,
): void {
  registry.register(buildSkillViewTool(skillRegistry));
  registry.register(buildSkillRunScriptTool(skillRegistry, dangerous));
}
