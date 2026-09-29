import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isSafeToRemove, type UninstallTarget } from "./uninstall-targets.js";
import { stripInstallerPathLine } from "./strip-installer-path-line.js";
import {
  createUserPathStore,
  removeUserPathEntry,
  type UserPathStore,
} from "./windows-user-path.js";

/** Rc files `install.sh` can have written its PATH stanza into. */
export function installerRcCandidates(homeDir: string): readonly string[] {
  return [
    join(homeDir, ".zshrc"),
    join(homeDir, ".bashrc"),
    join(homeDir, ".bash_profile"),
    join(homeDir, ".profile"),
    join(homeDir, ".config", "fish", "config.fish"),
  ];
}

export interface RemovalOutcome {
  readonly path: string;
  readonly ok: boolean;
  /** Present when `ok` is false. Already human-readable. */
  readonly error?: string;
}

export interface UninstallResult {
  readonly removed: readonly RemovalOutcome[];
  /** Rc files whose installer stanza was taken out. */
  readonly rcFilesEdited: readonly string[];
  /**
   * The directory taken out of the Windows user `Path`, when there was
   * one to take out. Absent everywhere else.
   */
  readonly userPathEntryRemoved?: string;
  /** True when every removal succeeded. */
  readonly complete: boolean;
}

export interface RunUninstallOptions {
  readonly targets: readonly UninstallTarget[];
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  /**
   * The install dir `install.ps1` added to the user `Path`. Only set when
   * the plan found an installed binary there: under a dev runtime this
   * would be node's own directory, which is not ours to take off `Path`.
   */
  readonly installDir?: string;
  /** Skip rc-file and user-`Path` editing (`--keep-path`). */
  readonly keepPathEntry?: boolean;
  /** The Windows user `Path`. Defaults to PowerShell; injected by tests. */
  readonly userPathStore?: UserPathStore;
  /** Per-step progress, so the TUI and the CLI can narrate the same run. */
  readonly onProgress?: (message: string) => void;
}

/**
 * Delete the planned targets and take the installer's PATH stanza back
 * out of the operator's rc file.
 *
 * Failures do not abort the run. A half-uninstall that stops at the
 * first EPERM is the worst outcome available — it leaves the operator
 * with neither a working install nor a clean machine — so every target
 * is attempted and the failures are reported together at the end.
 *
 * On Windows the running binary cannot delete itself; that shows up
 * here as a failed target with the OS message, and the CLI tells the
 * operator which single file is left.
 */
export async function runUninstall(
  options: RunUninstallOptions,
): Promise<UninstallResult> {
  const home = options.homeDir ?? homedir();
  const progress = options.onProgress ?? (() => {});
  const removed: RemovalOutcome[] = [];

  for (const target of options.targets) {
    if (!isSafeToRemove(target.path, home)) {
      removed.push({
        path: target.path,
        ok: false,
        error: "refused: not a path atomic-agent installs",
      });
      continue;
    }
    try {
      progress(`removing ${target.path}`);
      await rm(target.path, { recursive: true, force: true });
      removed.push({ path: target.path, ok: true });
    } catch (err) {
      removed.push({
        path: target.path,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const platform = options.platform ?? process.platform;
  const rcFilesEdited: string[] = [];
  let userPathEntryRemoved: string | undefined;
  if (!options.keepPathEntry && platform === "win32" && options.installDir) {
    // install.ps1 does not write an rc file; its PATH entry lives in
    // HKCU\Environment, so that is where it has to come back out of.
    const installDir = options.installDir;
    const store = options.userPathStore ?? createUserPathStore();
    try {
      const current = await store.read();
      const next =
        current === null ? null : removeUserPathEntry(current, installDir);
      if (next?.changed) {
        await store.write(next.value);
        progress(`removed ${installDir} from your user PATH`);
        userPathEntryRemoved = installDir;
      }
    } catch (err) {
      removed.push({
        path: `user PATH entry ${installDir}`,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!options.keepPathEntry) {
    for (const rc of installerRcCandidates(home)) {
      let content: string;
      try {
        content = await readFile(rc, "utf8");
      } catch {
        continue;
      }
      const stripped = stripInstallerPathLine(content);
      if (!stripped.changed) continue;
      try {
        await writeFile(rc, stripped.content, "utf8");
        progress(`removed the PATH entry from ${rc}`);
        rcFilesEdited.push(rc);
      } catch (err) {
        removed.push({
          path: rc,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    removed,
    rcFilesEdited,
    ...(userPathEntryRemoved ? { userPathEntryRemoved } : {}),
    complete: removed.every((entry) => entry.ok),
  };
}
