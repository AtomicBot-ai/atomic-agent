import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, type InstallSkillResult } from "../skill-installer.js";
import { parseSkillFile, type SkillManifest } from "../skill-manifest.js";
import {
  GithubSkillClient,
  type SkillHubClient,
} from "./github-skill-client.js";
import {
  parseSkillIdentifier,
  type SkillIdentifier,
} from "./skill-hub-source.js";
import {
  scanSkillFiles,
  summarizeScan,
  type SkillScanResult,
} from "./skill-security-scanner.js";

/**
 * Hub install pipeline: download a skill directory from GitHub into a
 * temp dir, run the security scan, then hand the temp dir to the
 * existing local {@link installSkill} so the on-disk install path is
 * identical to a local install.
 *
 * Two entry styles:
 *  - `stageSkillFromHub` → download + scan + parse manifest, return a
 *    staging handle. The caller decides (e.g. after a TUI confirm) to
 *    `commitStagedInstall` or `discardStagedInstall`. The temp dir lives
 *    until one of those is called.
 *  - `installSkillFromHub` → one-shot convenience used by the CLI:
 *    stage, gate on the scan ({@link enforceScanGate}), commit, discard.
 */

export type SkillHubInstallErrorCode =
  | "invalid_identifier"
  | "manifest_missing"
  | "dangerous_blocked"
  | "needs_confirmation";

export class SkillHubInstallError extends Error {
  constructor(
    message: string,
    public readonly code: SkillHubInstallErrorCode,
    public readonly scan?: SkillScanResult,
  ) {
    super(message);
    this.name = "SkillHubInstallError";
  }
}

export interface StagedSkillInstall {
  identifier: string;
  manifest: SkillManifest;
  scan: SkillScanResult;
  /** Temp directory holding the downloaded skill (SKILL.md at root). */
  sourceDir: string;
}

export interface StageSkillOptions {
  identifier: string;
  client?: SkillHubClient;
  /** Override temp root (tests). Defaults to the OS temp dir. */
  tmpRoot?: string;
}

export async function stageSkillFromHub(
  options: StageSkillOptions,
): Promise<StagedSkillInstall> {
  let id: SkillIdentifier;
  try {
    id = parseSkillIdentifier(options.identifier);
  } catch (err) {
    throw new SkillHubInstallError(
      err instanceof Error ? err.message : String(err),
      "invalid_identifier",
    );
  }

  const client = options.client ?? new GithubSkillClient();
  const ref = id.ref ?? (await client.resolveDefaultBranch(id.owner, id.repo));

  const tmpBase = options.tmpRoot ?? tmpdir();
  const sourceDir = await mkdtemp(join(tmpBase, "atomic-skill-"));
  try {
    const files = await client.downloadSkillDir(
      id.owner,
      id.repo,
      ref,
      id.path,
      sourceDir,
    );
    const manifestFile = files.find((f) => f.relativePath === "SKILL.md");
    if (!manifestFile) {
      throw new SkillHubInstallError(
        `SKILL.md not found at ${options.identifier}`,
        "manifest_missing",
      );
    }
    const { manifest } = parseSkillFile(manifestFile.content);
    const scan = scanSkillFiles(
      files.map((f) => ({ path: f.relativePath, content: f.content })),
    );
    return {
      identifier: options.identifier,
      manifest,
      scan,
      sourceDir,
    };
  } catch (err) {
    await discardDir(sourceDir);
    throw err;
  }
}

export interface ScanGateOptions {
  /** Allow installing despite a `dangerous` verdict (implies caution). */
  acknowledgeRisk?: boolean;
  /** Caution already approved up front (`--yes`, `confirm: true`). */
  confirmCaution?: boolean;
  /**
   * Ask the operator about a `caution` verdict (interactive CLI). Returns
   * true to install. Not consulted when caution is already approved.
   */
  confirm?: (scan: SkillScanResult) => Promise<boolean>;
}

/**
 * The one install policy every path applies to a scan result:
 *  - `dangerous` is blocked unless `acknowledgeRisk`;
 *  - `caution` needs an explicit yes: `acknowledgeRisk`, `confirmCaution`
 *    or a `confirm` callback that returns true. With none of them the
 *    install is refused (`needs_confirmation`), so a script or a non-TTY
 *    run never installs a flagged skill by default;
 *  - `ok` passes.
 * Throws {@link SkillHubInstallError} carrying the scan, so callers can
 * show the findings and retry with the matching flag.
 */
export async function enforceScanGate(
  identifier: string,
  scan: SkillScanResult,
  options: ScanGateOptions,
): Promise<void> {
  if (scan.verdict === "ok") return;
  if (scan.verdict === "dangerous") {
    if (options.acknowledgeRisk) return;
    throw new SkillHubInstallError(
      `install blocked: ${identifier} flagged dangerous by the security scan (${summarizeScan(scan)})`,
      "dangerous_blocked",
      scan,
    );
  }
  if (options.acknowledgeRisk || options.confirmCaution) return;
  if (options.confirm && (await options.confirm(scan))) return;
  throw new SkillHubInstallError(
    `install needs confirmation: ${identifier} — ${summarizeScan(scan)}`,
    "needs_confirmation",
    scan,
  );
}

export interface CommitInstallOptions {
  targetRoot: string;
  force?: boolean;
}

export async function commitStagedInstall(
  staged: StagedSkillInstall,
  options: CommitInstallOptions,
): Promise<InstallSkillResult> {
  try {
    return await installSkill({
      sourceDir: staged.sourceDir,
      targetRoot: options.targetRoot,
      force: options.force,
    });
  } finally {
    await discardDir(staged.sourceDir);
  }
}

export async function discardStagedInstall(
  staged: StagedSkillInstall,
): Promise<void> {
  await discardDir(staged.sourceDir);
}

export interface InstallFromHubOptions extends ScanGateOptions {
  identifier: string;
  targetRoot: string;
  force?: boolean;
  client?: SkillHubClient;
  tmpRoot?: string;
}

export interface InstallFromHubResult {
  identifier: string;
  manifest: SkillManifest;
  installedAt: string;
  scan: SkillScanResult;
}

export async function installSkillFromHub(
  options: InstallFromHubOptions,
): Promise<InstallFromHubResult> {
  const staged = await stageSkillFromHub({
    identifier: options.identifier,
    client: options.client,
    tmpRoot: options.tmpRoot,
  });
  try {
    await enforceScanGate(options.identifier, staged.scan, options);
  } catch (err) {
    await discardStagedInstall(staged);
    throw err;
  }
  const result = await commitStagedInstall(staged, {
    targetRoot: options.targetRoot,
    force: options.force,
  });
  return {
    identifier: options.identifier,
    manifest: result.manifest,
    installedAt: result.installedAt,
    scan: staged.scan,
  };
}

async function discardDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
