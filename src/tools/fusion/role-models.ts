import type { FusionRole } from "../../config/llm-run-mode-config.js";
import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * Models by role and by node (ATO-943).
 *
 * The planner tags a task with a `role` or names a `model`; this decides
 * which provider each task actually runs on, before anything starts:
 *
 *   explicit `model` (must be on the allowed list) > the role's model >
 *   the worker leg, as before.
 *
 * The allowed list is the worker leg plus every configured role model,
 * matched by model name or provider id. A name outside it refuses the
 * call (`unknownModels`), with the list, so the planner fixes it in one
 * regeneration.
 *
 * One guard: a second LOCAL model. A llama-server provider other than
 * the ones the session's legs already hold needs its own server and its
 * own memory, which this process cannot measure; without
 * `mixLocalModels` such a task runs on the worker leg and its row says
 * so. With no local leg held yet, the first extra local provider is
 * allowed and any different one after it is guarded the same way.
 */

/** Where one task runs. */
export interface TaskLeg {
  providerId: string;
  /** Display and pricing label. */
  model: string;
  /** Whether it is the session's worker leg (the old, only, path). */
  isWorkerLeg: boolean;
  /** The role whose model this is, when a role picked it. */
  role?: FusionRole;
  /** Why the task did not run where it asked to, for its row. */
  note?: string;
}

export interface WorkerLegRef {
  providerId: string;
  model: string;
}

/** Every model a task may name, worker leg first, each once. */
export function allowedModels(
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
): { providerId: string; model: string }[] {
  const out = [{ providerId: workerLeg.providerId, model: workerLeg.model }];
  for (const entry of Object.values(roles?.byRole ?? {})) {
    if (entry === undefined) continue;
    if (out.some((o) => o.providerId === entry.providerId)) continue;
    out.push({
      providerId: entry.providerId,
      model: entry.model ?? entry.providerId,
    });
  }
  return out;
}

/** The tasks whose `model` is not on the allowed list, as one refusal. */
export function unknownModels(
  tasks: readonly DelegateTask[],
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
): string | undefined {
  const allowed = allowedModels(workerLeg, roles);
  const bad = tasks.filter(
    (t) =>
      t.model !== undefined &&
      !allowed.some((a) => a.model === t.model || a.providerId === t.model),
  );
  if (bad.length === 0) return undefined;
  const names = allowed.map((a) => `\`${a.model}\``).join(", ");
  return `validation: ${bad
    .map((t) => `task "${t.id}" names model "${t.model}"`)
    .join("; ")}, which is not available here. Allowed models: ${names}. Use a task \`role\` or one of these names, or leave \`model\` out.`;
}

/**
 * Where each task runs, in task order. Assumes `unknownModels` passed.
 * Pure: the same tasks and run mode always give the same legs.
 */
export function resolveTaskLegs(
  tasks: readonly DelegateTask[],
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
): Map<string, TaskLeg> {
  const legs = new Map<string, TaskLeg>();
  const workerDefault = (note?: string): TaskLeg => ({
    providerId: workerLeg.providerId,
    model: workerLeg.model,
    isWorkerLeg: true,
    ...(note === undefined ? {} : { note }),
  });
  // Local providers this fan-out holds: the legs', then the first extra
  // one a task is allowed onto.
  const heldLocal = new Set(roles?.localLegProviderIds ?? []);
  for (const task of tasks) {
    const byRole = roles?.byRole ?? {};
    let picked:
      | { providerId: string; model: string; local: boolean; role?: FusionRole }
      | undefined;
    if (task.model !== undefined) {
      if (
        task.model === workerLeg.model ||
        task.model === workerLeg.providerId
      ) {
        legs.set(task.id, workerDefault());
        continue;
      }
      // The task's own role first, so a model shared by two roles is
      // attributed to the role the planner meant.
      const ordered = Object.entries(byRole).sort(([a], [b]) =>
        a === task.role ? -1 : b === task.role ? 1 : 0,
      );
      for (const [role, entry] of ordered) {
        if (entry === undefined) continue;
        if (entry.model === task.model || entry.providerId === task.model) {
          picked = {
            providerId: entry.providerId,
            model: entry.model ?? entry.providerId,
            local: entry.local,
            ...(task.role === role ? { role: role as FusionRole } : {}),
          };
          break;
        }
      }
    } else if (task.role !== undefined) {
      const entry = byRole[task.role];
      if (entry === undefined) {
        // A role with no model of its own is the worker leg's work, said
        // only when roles are configured at all (flag absent: no notes).
        legs.set(
          task.id,
          workerDefault(
            roles === undefined
              ? undefined
              : `role ${task.role} has no model configured (llm.runMode.fusion.roles.${task.role}); ran on the workers' model ${workerLeg.model}`,
          ),
        );
        continue;
      }
      picked = {
        providerId: entry.providerId,
        model: entry.model ?? entry.providerId,
        local: entry.local,
        role: task.role,
      };
    }
    if (picked === undefined) {
      legs.set(task.id, workerDefault());
      continue;
    }
    if (picked.providerId === workerLeg.providerId) {
      legs.set(task.id, {
        ...workerDefault(),
        ...(picked.role === undefined ? {} : { role: picked.role }),
      });
      continue;
    }
    if (
      picked.local &&
      !heldLocal.has(picked.providerId) &&
      heldLocal.size > 0 &&
      roles?.mixLocalModels !== true
    ) {
      legs.set(
        task.id,
        workerDefault(
          `${picked.model} is a second local model and this machine is not marked to hold two (llm.runMode.fusion.mixLocalModels); ran on the workers' model ${workerLeg.model}`,
        ),
      );
      continue;
    }
    if (picked.local) heldLocal.add(picked.providerId);
    legs.set(task.id, {
      providerId: picked.providerId,
      model: picked.model,
      isWorkerLeg: false,
      ...(picked.role === undefined ? {} : { role: picked.role }),
    });
  }
  return legs;
}
