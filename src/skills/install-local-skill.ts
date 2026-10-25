import {
  enforceScanGate,
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
 * `installSkill` itself stays a plain validated copy: it is also the
 * commit step for already-scanned staged installs and the importers'
 * copy of the user's own skills from another agent.
 */
export interface InstallLocalSkillOptions
  extends InstallSkillOptions, ScanGateOptions {}

export interface InstallLocalSkillResult extends InstallSkillResult {
  scan: SkillScanResult;
}

export async function installLocalSkill(
  options: InstallLocalSkillOptions,
): Promise<InstallLocalSkillResult> {
  // Fail on the source, the manifest and an existing install before the
  // scan: never ask anyone to confirm findings for an install that would
  // fail anyway. `installSkill` repeats these checks right before copying.
  const { sourceDir } = await prepareSkillInstall(options);
  const { verdict, findings } = await scanSkillDir(sourceDir);
  const scan: SkillScanResult = { verdict, findings };
  await enforceScanGate(sourceDir, scan, options);
  const result = await installSkill({
    sourceDir,
    targetRoot: options.targetRoot,
    ...(options.force ? { force: true } : {}),
  });
  return { ...result, scan };
}
