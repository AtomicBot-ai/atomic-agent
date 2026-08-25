import {
  basename,
  dirname,
  posix as pathPosix,
  resolve,
  sep,
  win32 as pathWin32,
} from "node:path";

/**
 * What a target is, so the UI can group and colour it without parsing
 * paths. `data` is everything the operator produced — the config, the
 * memory fabric, sessions, downloaded weights — and is the half that
 * cannot be reinstalled. `program` is what the installer put there and
 * what `install.sh` would put back.
 */
export type UninstallTargetGroup = "data" | "program";

export interface UninstallTarget {
  /** Absolute path to remove, file or directory. */
  readonly path: string;
  /** One-line description shown in the confirm screens. */
  readonly label: string;
  readonly group: UninstallTargetGroup;
}

export interface UninstallPlanInput {
  /** `getConfig().paths.stateDir` — honours `ATOMIC_AGENT_STATE_DIR`. */
  readonly stateDir: string;
  /** `process.execPath`. A dev run points at `node` and installs nothing. */
  readonly execPath: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  /**
   * Whether `<installDir>/atomic-agent` exists. Every `program` target is
   * gated on it: the install dir is shared (`~/.local/bin` holds other
   * people's tools), so `node_modules` and `vendor` next to *our* binary
   * are ours to delete, and the same names next to somebody else's are
   * not. The caller stats it — this module stays pure.
   */
  readonly binaryPresent: boolean;
}

/**
 * Directories the installer drops beside the binary. Kept in the same
 * order `install.sh` writes them so the two lists can be diffed by eye
 * when either changes.
 */
const INSTALLED_ASSET_DIRS: readonly string[] = [
  "grammars",
  "starter-skills",
  "assets",
  "vendor",
  "prebuilds",
  "node_modules",
];

/**
 * The path flavour to reason in. Explicit rather than `node:path`'s
 * ambient default for the same reason `run-app-update.ts` does it: a
 * Windows `execPath` has to parse correctly in a test running on a Mac,
 * and on the real machine the two agree anyway.
 */
function pathFor(platform: NodeJS.Platform): typeof pathPosix {
  return platform === "win32" ? pathWin32 : pathPosix;
}

/** Where `runAppUpdate` and `install.sh` agree the program lives. */
export function installDirFor(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).dirname(execPath);
}

/**
 * Whether `execPath` is the installed binary rather than a dev runtime.
 * Same test `canSelfUpdate` makes, and for the same reason: under `node`
 * or `tsx` there is nothing installed to remove.
 */
export function isInstalledBinary(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const exe = pathFor(platform).basename(execPath).toLowerCase();
  if (exe.startsWith("node") || exe.startsWith("tsx")) return false;
  return exe.startsWith("atomic-agent");
}

/**
 * Everything `atomic-agent uninstall` would remove, in the order it is
 * shown and removed: data first, program second.
 *
 * Pure — no `fs`, no `process`. The caller stats the result to fill in
 * sizes (`measureUninstallPlan`) and to drop what does not exist.
 */
export function planUninstallTargets(
  input: UninstallPlanInput,
): readonly UninstallTarget[] {
  const path = pathFor(input.platform);
  const targets: UninstallTarget[] = [
    {
      path: path.resolve(input.stateDir),
      label: "config, memory, sessions, tasks, traces, downloaded models",
      group: "data",
    },
    {
      path: path.resolve(input.homeDir, "Documents", "atomic-agent-debug"),
      label: "debug bundles written by /dump",
      group: "data",
    },
  ];

  if (!isInstalledBinary(input.execPath, input.platform) || !input.binaryPresent) {
    // A dev checkout is uninstalled with `git`; saying so is the whole
    // point of returning data-only rather than guessing an install dir.
    return targets;
  }

  const installDir = installDirFor(input.execPath, input.platform);
  const exeSuffix = input.platform === "win32" ? ".exe" : "";
  targets.push({
    path: path.resolve(installDir, `atomic-agent${exeSuffix}`),
    label: "the binary",
    group: "program",
  });
  targets.push({
    path: path.resolve(installDir, `atag${exeSuffix}`),
    label: "the short alias",
    group: "program",
  });
  for (const dir of INSTALLED_ASSET_DIRS) {
    targets.push({
      path: path.resolve(installDir, dir),
      label: `installed ${dir}`,
      group: "program",
    });
  }
  return targets;
}

/**
 * Paths that must never be handed to `rm -rf`, however we got there.
 *
 * This is a backstop, not the design: the plan above only ever names
 * paths it built itself. But it builds them out of `process.execPath`
 * and an env var, and the cost of one of those being empty or `/` is
 * the operator's home directory. A denylist that costs a string compare
 * is the right price for that.
 */
export function isSafeToRemove(path: string, homeDir: string): boolean {
  const target = resolve(path);
  const home = resolve(homeDir);
  if (target === home) return false;
  // Root of a POSIX filesystem or of a Windows drive: `dirname` of a
  // root is the root itself, which is the only fixed point there is.
  if (dirname(target) === target) return false;
  if (basename(target).length === 0) return false;
  const segments = target.split(sep).filter((part) => part.length > 0);
  // `/usr`, `/etc`, `C:\Windows` — one segment deep and outside home is
  // never something we installed.
  if (segments.length < 2 && !target.startsWith(`${home}${sep}`)) return false;
  return true;
}
