import type { ResolvedUninstallPlan } from "./resolve-uninstall-plan.js";

/**
 * Whether carrying out `plan` as it stands would delete data the desktop
 * app uses: a current desktop app shares the state directory and the
 * state directory is one of the targets. False under `--keep-data`,
 * where the folder is not in the plan.
 */
export function plansToDeleteDesktopData(plan: ResolvedUninstallPlan): boolean {
  return (
    plan.desktop.sharesStateDir &&
    plan.targets.some((target) => target.path === plan.desktop.stateDir)
  );
}

/**
 * `plan` with every `data` target dropped, the same cut `--keep-data`
 * makes, so only the terminal program is removed. Used when the desktop
 * app shares the state directory and nobody explicitly agreed to delete
 * its chats, memory, settings, API keys and models: unattended runs
 * (`--yes`) and an operator who answered "no" to the separate desktop
 * question. Pure: the sizes come from the plan already measured, so
 * the list shown is the list removed.
 */
export function keepDesktopData(
  plan: ResolvedUninstallPlan,
): ResolvedUninstallPlan {
  const targets = plan.targets.filter((target) => target.group !== "data");
  const measured = plan.measured.targets.filter(
    (target) => target.group !== "data",
  );
  return {
    ...plan,
    targets,
    measured: {
      targets: measured,
      totalBytes: measured.reduce((sum, target) => sum + target.bytes, 0),
    },
  };
}
