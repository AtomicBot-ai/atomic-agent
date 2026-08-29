import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  measureUninstallPlan,
  type MeasuredPlan,
} from "./measure-uninstall-plan.js";
import {
  installDirFor,
  isInstalledBinary,
  planUninstallTargets,
  type UninstallTarget,
} from "./uninstall-targets.js";

export interface ResolvedUninstallPlan {
  readonly targets: readonly UninstallTarget[];
  readonly measured: MeasuredPlan;
  /**
   * True when the process is `node`/`tsx` against a checkout, or the
   * installed binary is gone. Both mean there is no program half to
   * remove, and the caller says so instead of pretending it removed one.
   */
  readonly devCheckout: boolean;
  /** `dirname(execPath)`, shown so the operator can check it themselves. */
  readonly installDir: string;
}

export interface ResolveUninstallPlanOptions {
  /** `getConfig().paths.stateDir`. Required — never guessed here. */
  readonly stateDir: string;
  readonly execPath?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  /** Drop the state dir and debug bundles from the plan (`--keep-data`). */
  readonly keepData?: boolean;
  /** Drop the binary and its assets from the plan (`--keep-binary`). */
  readonly keepBinary?: boolean;
}

/**
 * The one place the CLI and the TUI both build their plan from, so the
 * list the confirm screen shows is byte-for-byte the list that gets
 * removed. Two code paths that each assemble "what uninstall means"
 * would eventually disagree, and the disagreement would only show up
 * after the deletion.
 */
export async function resolveUninstallPlan(
  options: ResolveUninstallPlanOptions,
): Promise<ResolvedUninstallPlan> {
  const execPath = options.execPath ?? process.execPath;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const installDir = installDirFor(execPath);
  const exeSuffix = platform === "win32" ? ".exe" : "";
  const binaryPresent =
    isInstalledBinary(execPath) &&
    (await exists(resolve(installDir, `atomic-agent${exeSuffix}`)));

  const all = planUninstallTargets({
    stateDir: options.stateDir,
    execPath,
    homeDir,
    platform,
    binaryPresent,
  });
  const targets = all.filter((target) => {
    if (options.keepData && target.group === "data") return false;
    if (options.keepBinary && target.group === "program") return false;
    return true;
  });

  return {
    targets,
    measured: await measureUninstallPlan(targets),
    devCheckout: !binaryPresent,
    installDir,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
