/**
 * Lays out `node_modules/@lydell/node-pty` (the pty binding behind
 * interactive `os.shell.run` jobs, ATO-2484; see
 * `src/native/load-node-pty.ts`) next to the SEA binary, plus the
 * prebuilt package for the bundle's target
 * (`@lydell/node-pty-<platform>-<arch>`: the `.node` addon, and on macOS
 * its `spawn-helper`, on Windows the ConPTY / winpty files).
 *
 * The packages are copied whole, so file modes (the executable bit of
 * `spawn-helper`) survive. The loader degrades to `script(1)` or plain
 * pipes when the package is absent, so a missing copy is a warning, not
 * a failure: same contract as the keyring copy in package-bundle.ts.
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const NODE_PTY_SCOPE = "@lydell";
export const NODE_PTY_MAIN = "node-pty";

/** The prebuild package name for one target, e.g. `node-pty-win32-x64`. */
export function nodePtyPrebuildName(platform: string, arch: string): string {
  return `${NODE_PTY_MAIN}-${platform}-${arch}`;
}

/**
 * Which installed prebuild packages go into the bundle: the target's own
 * one only. A runner that has others installed (it never should: npm
 * installs the host's) does not ship them.
 */
export function pickNodePtyPrebuilds(
  installed: readonly string[],
  platform: string,
  arch: string,
): string[] {
  const wanted = nodePtyPrebuildName(platform, arch);
  return installed.filter((name) => name === wanted);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface CopyNodePtyResult {
  copiedMain: boolean;
  prebuilds: string[];
  warnings: string[];
}

export async function copyNodePtyRuntime(
  rootDir: string,
  stageDir: string,
  target: { platform: string; arch: string },
): Promise<CopyNodePtyResult> {
  const scopeSrc = join(rootDir, "node_modules", NODE_PTY_SCOPE);
  const scopeDest = join(stageDir, "node_modules", NODE_PTY_SCOPE);
  const mainSrc = join(scopeSrc, NODE_PTY_MAIN);
  const warnings: string[] = [];
  if (!(await exists(mainSrc))) {
    warnings.push(
      `${NODE_PTY_SCOPE}/${NODE_PTY_MAIN} not found under node_modules; interactive shell jobs use script(1) or pipes in this bundle.`,
    );
    return { copiedMain: false, prebuilds: [], warnings };
  }
  await mkdir(scopeDest, { recursive: true });
  await cp(mainSrc, join(scopeDest, NODE_PTY_MAIN), { recursive: true });
  const prebuilds = pickNodePtyPrebuilds(await readdir(scopeSrc), target.platform, target.arch);
  for (const name of prebuilds) {
    await cp(join(scopeSrc, name), join(scopeDest, name), { recursive: true });
  }
  if (prebuilds.length === 0) {
    warnings.push(
      `no ${NODE_PTY_SCOPE}/${nodePtyPrebuildName(target.platform, target.arch)} prebuild installed; interactive shell jobs use script(1) or pipes in this bundle.`,
    );
  }
  return { copiedMain: true, prebuilds, warnings };
}
