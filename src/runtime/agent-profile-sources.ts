import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";
import {
  loadAgentProfiles,
  normaliseProfileName,
  readSettingsAgentProfiles,
  type AgentProfile,
  type AgentProfileSet,
} from "../agent-profiles/index.js";
import { listPluginSubagents } from "../plugins/plugin-subagents.js";

/**
 * The agent profiles for a folder, from every source the runtime reads
 * (project, user, settings, plugins, built-ins), reread on each call.
 * One loader for `fusion.delegate`, `subagent.run` and a board card's
 * assignee (ATO-2498).
 */
export function loadRuntimeAgentProfiles(
  config: Pick<AtomicAgentConfig, "paths" | "skills">,
  dir: string,
): AgentProfileSet {
  return loadAgentProfiles({
    workingDir: dir,
    stateDir: config.paths.stateDir,
    configFile: config.paths.userConfigFile,
    startupTrust: config.skills.projectTrust,
    settingsProfiles: () =>
      readSettingsAgentProfiles(config.paths.userConfigFile, () => getConfig().llm?.runMode?.agentProfiles),
    pluginProfiles: () => pluginAgentProfiles(config.paths.stateDir),
  });
}

/**
 * Enabled plugins' `agents/*.md` as subagent profiles, named
 * `plugin:agent`; a name that does not normalise is skipped.
 */
function pluginAgentProfiles(stateDir: string): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const p of listPluginSubagents(stateDir).profiles) {
    const [plugin, agent] = [normaliseProfileName(p.plugin), normaliseProfileName(p.name.slice(p.plugin.length + 1))];
    if (plugin === null || agent === null || p.prompt.trim().length === 0) continue;
    out.push({
      name: `${plugin}:${agent}`,
      description: p.description,
      prompt: p.prompt.trim(),
      ...(p.model === undefined ? {} : { model: p.model }),
      ...(p.tools.length === 0 ? {} : { tools: p.tools }),
      source: "plugin",
      file: p.file,
    });
  }
  return out;
}
