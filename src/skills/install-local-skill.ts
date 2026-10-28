import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enforceScanGate,
  scanIdOf,
  type ScanGateOptions,
} from "./hub/install-from-hub.js";
import { scanSkillDir } from "./hub/scan-skill-dir.js";
import type { SkillScanResult } from "./hub/skill-security-scanner.js";
import {
  installSkill,
  prepareSkillInstall,
  type InstallSkillOptions,
  type InstallSkillResult,
} from "./skill-installer.js";

/**
 * Install a skill from a local folder through the same security scan and
 * gate as GitHub-tap and ClawHub installs. A folder someone handed you is
 * no more trustworthy than a registry download, so `operator-chosen path`
 * is not a reason to skip the scan.
 *
 * The folder is first copied into a private temp dir (symlinks copied as
 * links, never followed); that copy is scanned and that same copy is
 * installed. Scanning the live folder and copying it afterwards would let
 * anyone who can write to it swap a file in between (TOCTOU).
 *
 * `installSkill` itself stays a plain validated copy: it is also the
 * commit step for already-scanned staged installs and the importers'
 * copy of the user's own skills from another agent.
 */
export interface InstallLocalSkillOptions
  extends InstallSkillOptions, ScanGateOptions {
  /** Override the staging temp root (tests). Defaults to the OS temp dir. */
  tmpRoot?: string;
}

export interface InstallLocalSkillResult extends InstallSkillResult {
  scan: SkillScanResult;
  /** {@link scanIdOf} the scan, for callers that bind a confirmation. */
  scanId: string;
}

export async function installLocalSkill(
  options: InstallLocalSkillOptions,
): Promise<InstallLocalSkillResult> {
  // Fail on the source, the manifest and an existing install before the
  // scan: never ask anyone to confirm findings for an install that would
  // fail anyway. `installSkill` repeats these checks right before copying.
  const { sourceDir } = await prepareSkillInstall(options);
  const stagingRoot = await mkdtemp(
    join(options.tmpRoot ?? tmpdir(), "atomic-local-skill-"),
  );
  try {
    const staged = join(stagingRoot, "skill");
    await cp(sourceDir, staged, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    const { verdict, findings } = await scanSkillDir(staged);
    const scan: SkillScanResult = { verdict, findings };
    await enforceScanGate(sourceDir, scan, options);
    const result = await installSkill({
      sourceDir: staged,
      targetRoot: options.targetRoot,
      verbatimSymlinks: true,
      ...(options.force ? { force: true } : {}),
    });
    return { ...result, scan, scanId: scanIdOf(scan) };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}
