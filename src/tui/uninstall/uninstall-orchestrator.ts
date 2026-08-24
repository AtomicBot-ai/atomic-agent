import {
  formatBytes,
  resolveUninstallPlan,
  runUninstall,
  type ResolvedUninstallPlan,
} from "../../uninstall/index.js";
import type { UninstallPreview } from "./uninstall-state.js";

/** Turn a resolved plan into the strings the modal renders. */
export function toPreview(plan: ResolvedUninstallPlan): UninstallPreview {
  return {
    rows: plan.measured.targets.map((target) => ({
      path: target.path,
      label: target.label,
      size: formatBytes(target.bytes),
      group: target.group,
    })),
    total: formatBytes(plan.measured.totalBytes),
    devCheckout: plan.devCheckout,
  };
}

export interface UninstallBus {
  emit(action: { type: string } & Record<string, unknown>): void;
}

/**
 * Measure the install for the dialog's first screen.
 *
 * Reading a state directory with a few gigabytes of GGUF in it takes
 * long enough to see, which is why the dialog opens on a `loading` step
 * instead of appearing already populated. Failures land on the `failed`
 * step rather than closing the dialog: an operator who asked to
 * uninstall and got nothing at all would reasonably assume it worked.
 */
export async function loadUninstallPreview(
  bus: UninstallBus,
  stateDir: string,
): Promise<void> {
  try {
    const plan = await resolveUninstallPlan({ stateDir });
    bus.emit({ type: "uninstall_plan_loaded", preview: toPreview(plan) });
  } catch (err) {
    bus.emit({
      type: "uninstall_plan_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface PerformUninstallOptions {
  readonly stateDir: string;
  readonly write?: (text: string) => void;
}

/**
 * The removal itself, run **after** Ink has unmounted and the runtime
 * has shut down — see the tail of `tui-command.ts`.
 *
 * Doing it here rather than from inside the running app is not a
 * detail. The state directory holds three open SQLite databases and,
 * under the managed runtime, a llama-server with model weights mapped
 * out of it. Deleting that from under a live process leaves handles
 * writing into unlinked inodes on POSIX and fails outright on Windows,
 * and either way the operator watches the directory they just removed
 * blink back into existence. Shutting down first costs a second and
 * makes the result true.
 *
 * Returns the process exit code.
 */
export async function performUninstall(
  options: PerformUninstallOptions,
): Promise<number> {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  write("uninstalling atomic-agent…\n");
  let plan: ResolvedUninstallPlan;
  try {
    plan = await resolveUninstallPlan({ stateDir: options.stateDir });
  } catch (err) {
    write(`uninstall failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const result = await runUninstall({
    targets: plan.targets,
    onProgress: (line) => write(`  ${line}\n`),
  });
  for (const rc of result.rcFilesEdited) {
    write(`  edited ${rc} — open a new shell for PATH to catch up\n`);
  }
  const failures = result.removed.filter((entry) => !entry.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      write(`could not remove ${failure.path}: ${failure.error}\n`);
    }
    write(
      `${failures.length} of ${result.removed.length} targets are still there — ` +
        "remove them by hand to finish\n",
    );
    return 1;
  }
  write("atomic-agent is uninstalled. Thanks for trying it.\n");
  return 0;
}
