import {
  FUSION_ROLES,
  type FusionRole,
} from "../../config/llm-run-mode-config.js";
import {
  compileToolAllowlist,
  type AgentProfileSet,
} from "../../agent-profiles/index.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * Subagent profiles on delegated tasks (ATO-566).
 *
 * A task that names `profile` gets, from that profile:
 *  - its instructions, quoted into the worker brief (`renderWorkerBrief`);
 *  - its tool allowlist, ANDed with the worker's own exclusions
 *    (`workerToolFilterFor`), so it only ever narrows;
 *  - its `model`, but only when the task itself named neither `model`
 *    nor `role` (the planner's explicit pick wins). A model that is a
 *    fusion role (`explore`, `review`, ...) becomes the task's `role`; a
 *    name on the allowed list becomes its `model`; `inherit` and any
 *    other name leave the task on its usual leg with a note, never a
 *    refusal: a profile written for another agent (`model: sonnet`)
 *    must not break the fan-out.
 *
 * An unknown profile name refuses the call, naming the ones there are,
 * so the planner fixes it in one regeneration.
 */
export interface AppliedProfileReport {
  task: string;
  profile: string;
  source: string;
  /** What the profile's `model` did, when it had one. */
  model?: string;
  /** The allowlist patterns, when the profile narrowed the tools. */
  tools?: readonly string[];
  notes?: string[];
}

export type ApplyTaskProfilesResult =
  | { ok: true; tasks: DelegateTask[]; applied: AppliedProfileReport[] }
  | { ok: false; error: string };

export function applyTaskProfiles(
  tasks: readonly DelegateTask[],
  profiles: AgentProfileSet,
  allowedModels: readonly { providerId: string; model: string }[],
): ApplyTaskProfilesResult {
  const unknown = tasks.filter(
    (t) => t.profile !== undefined && profiles.get(t.profile) === undefined,
  );
  if (unknown.length > 0) {
    const names = profiles.profiles.map((p) => `\`${p.name}\``).join(", ");
    return {
      ok: false,
      error: `${unknown
        .map((t) => `task "${t.id}" names profile "${t.profile}"`)
        .join("; ")}, which does not exist here. Profiles: ${names}. Use one of these names or leave \`profile\` out.`,
    };
  }
  const applied: AppliedProfileReport[] = [];
  const out = tasks.map((task): DelegateTask => {
    if (task.profile === undefined) return task;
    const profile = profiles.get(task.profile)!;
    const notes: string[] = [];
    const next: DelegateTask = { ...task };
    let modelNote: string | undefined;
    const wanted = profile.model;
    if (wanted !== undefined && wanted.toLowerCase() !== "inherit") {
      if (task.model !== undefined || task.role !== undefined) {
        modelNote = `kept the task's own ${task.model !== undefined ? `model ${task.model}` : `role ${task.role}`}`;
      } else if (FUSION_ROLES.includes(wanted as FusionRole)) {
        next.role = wanted as FusionRole;
        modelNote = `role ${wanted}`;
      } else if (allowedModels.some((m) => m.model === wanted || m.providerId === wanted)) {
        next.model = wanted;
        modelNote = `model ${wanted}`;
      } else {
        notes.push(`profile model "${wanted}" is not configured here; ran on the usual model`);
      }
    }
    const compiled = compileToolAllowlist(profile.tools);
    if (compiled.unknown.length > 0) {
      notes.push(
        compiled.allows === undefined
          ? `none of the profile's tools are known here (${compiled.unknown.join(", ")}); the worker kept its usual tools`
          : `unknown tools ignored: ${compiled.unknown.join(", ")}`,
      );
    }
    next.agentProfile = {
      name: profile.name,
      prompt: profile.prompt,
      ...(compiled.allows === undefined ? {} : { tools: compiled.patterns }),
    };
    applied.push({
      task: task.id,
      profile: profile.name,
      source: profile.source,
      ...(modelNote === undefined ? {} : { model: modelNote }),
      ...(compiled.allows === undefined ? {} : { tools: compiled.patterns }),
      ...(notes.length === 0 ? {} : { notes }),
    });
    return next;
  });
  return { ok: true, tasks: out, applied };
}
