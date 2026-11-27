import { getConfig } from "../../config/index.js";
import { FUSION_ROLES, type FusionRole } from "../../config/llm-run-mode-config.js";
import { compileToolAllowlist, type AgentProfileSet } from "../../agent-profiles/index.js";
import type { AssigneeResolver, AssigneeRun } from "../../tasks/task-board-assignee.js";
import { BOARD_CARD_TOOLS } from "../../tools/tasks/board-card-visibility.js";
import { loadRuntimeAgentProfiles } from "../agent-profile-sources.js";

/**
 * The runtime's `TaskRunnerOptions.assignee` (ATO-2498): a board card
 * assigned to an agent profile runs with that profile, read from the
 * same sources as `fusion.delegate` and `subagent.run` for the task's
 * folder, on every run (so a new or edited profile applies at once).
 *
 *  - instructions: the profile's body, quoted into the run's message;
 *  - tools: the profile's list (`compileToolAllowlist`), plus the board
 *    card tools, so the assignee can still report on its card;
 *  - model: a fusion role set up in `llm.runMode.fusion.roles`, or the
 *    id of a configured provider, pins the run to that provider; any
 *    other value (`inherit`, `sonnet` from a Claude Code file) keeps the
 *    usual model, with a note on the card.
 */
export function createBoardAssigneeResolver(
  loadProfiles: (dir: string) => AgentProfileSet = (dir) => loadRuntimeAgentProfiles(getConfig(), dir),
): AssigneeResolver {
  return (name, { workingDir }) => {
    const profile = loadProfiles(workingDir).get(name);
    if (!profile) return null;
    const notes: string[] = [];
    const compiled = compileToolAllowlist(profile.tools);
    if (compiled.unknown.length > 0) {
      notes.push(
        compiled.allows === undefined
          ? `None of its tools are known here (${compiled.unknown.join(", ")}), so it kept the usual tools.`
          : `Unknown tools were ignored: ${compiled.unknown.join(", ")}.`,
      );
    }
    const allows = compiled.allows;
    const run: AssigneeRun = {
      profile: profile.name,
      instructions: profile.prompt,
      notes,
      ...(allows ? { toolFilter: (tool: string) => BOARD_CARD_TOOLS.has(tool) || allows(tool) } : {}),
    };
    const wanted = profile.model?.trim();
    if (wanted && wanted.toLowerCase() !== "inherit") {
      const providerId = providerForProfileModel(wanted);
      if (providerId !== null) run.providerId = providerId;
      else notes.push(`Its model "${wanted}" is not set up here, so it ran on the usual model.`);
    }
    return run;
  };
}

/**
 * The provider a profile's `model` points at: the provider a fusion role
 * is set to, or a configured provider of that id; `null` otherwise. Read
 * from the live config, so a provider added in Settings counts at once.
 */
export function providerForProfileModel(model: string): string | null {
  const llm = getConfig().llm;
  if (FUSION_ROLES.includes(model as FusionRole)) {
    return llm?.runMode?.fusion?.roles?.[model as FusionRole] ?? null;
  }
  return (llm?.providers ?? []).some((p) => p.id === model) ? model : null;
}
