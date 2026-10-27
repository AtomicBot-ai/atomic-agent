import { createHash } from "node:crypto";
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
import { scanSkillDir } from "./scan-skill-dir.js";
import {
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
    // Scan the bytes on disk (what gets installed), not the in-memory copy.
    const { verdict, findings } = await scanSkillDir(sourceDir);
    const scan: SkillScanResult = { verdict, findings };
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
  /** Caution already approved up front (`--yes`, HTTP `confirm`). */
  confirmCaution?: boolean;
  /**
   * Bind `acknowledgeRisk` / `confirmCaution` to one scan: they only count
   * when {@link scanIdOf} of the current scan equals this id. HTTP and the
   * sidecar always pass it, so a "yes" covers exactly the findings the
   * person was shown; if the folder changed since, the scan id changes
   * and the install asks again.
   */
  approvedScanId?: string;
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
  const id = scanIdOf(scan);
  const bound =
    options.approvedScanId === undefined || options.approvedScanId === id;
  const acknowledged = bound && options.acknowledgeRisk === true;
  if (scan.verdict === "dangerous") {
    if (acknowledged) return;
    throw new SkillHubInstallError(
      `install blocked: ${identifier} flagged dangerous by the security scan (${summarizeScan(scan)}) [scanId ${id}]`,
      "dangerous_blocked",
      scan,
    );
  }
  if (acknowledged || (bound && options.confirmCaution === true)) return;
  if (options.confirm && (await options.confirm(scan))) return;
  throw new SkillHubInstallError(
    `install needs confirmation: ${identifier} — ${summarizeScan(scan)} [scanId ${id}]`,
    "needs_confirmation",
    scan,
  );
}

/**
 * Gate options for a client that answers by scan id (HTTP `confirm` /
 * `acknowledgeRisk`, sidecar `skill_install`). Only a string id counts;
 * with none, `approvedScanId` is still set (to `""`), so a bare `true`
 * can never approve anything. A dangerous approval also covers caution,
 * but only for its own scan.
 */
export function scanApprovalFromIds(answer: {
  confirm?: unknown;
  acknowledgeRisk?: unknown;
}): Required<Pick<ScanGateOptions, "confirmCaution" | "acknowledgeRisk" | "approvedScanId">> {
  const ack = typeof answer.acknowledgeRisk === "string" ? answer.acknowledgeRisk : "";
  const confirm = typeof answer.confirm === "string" ? answer.confirm : "";
  return {
    acknowledgeRisk: ack !== "",
    confirmCaution: confirm !== "" && (ack === "" || ack === confirm),
    approvedScanId: ack || confirm,
  };
}

/**
 * Stable id of a scan result: a hash of its verdict and findings (paths,
 * lines, excerpts). Same folder bytes give the same id; any change to a
 * finding gives a new one.
 */
export function scanIdOf(scan: SkillScanResult): string {
  const canonical = JSON.stringify({
    verdict: scan.verdict,
    findings: scan.findings.map((f) => [
      f.severity,
      f.rule,
      f.file,
      f.line,
      f.excerpt,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
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
