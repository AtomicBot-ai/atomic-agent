import { enforceScanGate, scanIdOf, type ScanGateOptions } from "../skills/hub/install-from-hub.js";
import { scanSkillDir } from "../skills/hub/scan-skill-dir.js";
import type { SkillScanResult } from "../skills/hub/skill-security-scanner.js";
import type { PluginReview, PluginReviewContext, PluginReviewDecision, StagedPlugin } from "./plugin-install.js";
import {
  codeConsentIdOf,
  describePermissionDiff,
  describePluginCode,
  diffPluginPermissions,
  pluginPermissionSnapshot,
  type PluginPermissionDiff,
  type PluginPermissionSnapshot,
} from "./plugin-permissions.js";

/**
 * Install safety for plugins (ATO-955), shared by the CLI and the desktop
 * sidecar:
 *
 * 1. Security scan over every file of the staged copy (skills, commands,
 *    agents, hooks.json, .mcp.json, anything else), with the same gate as
 *    skill installs: `caution` needs a yes, `dangerous` needs an explicit
 *    risk acknowledgement.
 * 2. Permission diff against the installed version on update / `--force`.
 * 3. Runs-code consent: a plugin that can run programs installs with those
 *    parts off until the person agrees, once per package. An earlier yes
 *    carries over an update only when nothing that runs changed.
 *
 * Consent never comes from the plugin itself, from prompt text or from a
 * headless default: only an interactive yes, `--accept-code`, or a client
 * echoing the consent id it showed.
 */

export interface PluginInstallReport {
  name: string;
  version: string;
  mode: PluginReviewContext["mode"];
  scan: SkillScanResult;
  scanId: string;
  snapshot: PluginPermissionSnapshot;
  /** What would run, one line each (empty for a data-only plugin). */
  code: string[];
  /** Id of exactly that list; a client answers "allow" with it. */
  consentId: string;
  diff: PluginPermissionDiff;
  /** The diff in plain words (empty on a first install). */
  changes: string[];
  /** True when an earlier consent still covers this version. */
  consentCarriedOver: boolean;
}

/** Scan + snapshot + diff of a staged plugin. Reads files, runs nothing, decides nothing. */
export async function inspectStagedPlugin(staged: StagedPlugin, context: PluginReviewContext): Promise<PluginInstallReport> {
  const scanned = await scanSkillDir(staged.dir);
  const scan: SkillScanResult = { verdict: scanned.verdict, findings: scanned.findings };
  const snapshot = pluginPermissionSnapshot(staged.bundle);
  const diff = diffPluginPermissions(context.previousBundle ?? null, staged.bundle);
  const hadConsent = context.previous?.runsCodeAccepted === true && !!context.previousBundle;
  return {
    name: staged.bundle.name,
    version: staged.bundle.manifest.version,
    mode: context.mode,
    scan,
    scanId: scanIdOf(scan),
    snapshot,
    code: describePluginCode(snapshot),
    consentId: codeConsentIdOf(snapshot),
    diff,
    changes: describePermissionDiff(diff),
    consentCarriedOver: snapshot.runsCode && hadConsent && !diff.codeChanged,
  };
}

export interface PluginReviewOptions extends ScanGateOptions {
  /**
   * Allow the plugin's code up front (`--accept-code`). With
   * `approvedConsentId` set it only counts for that exact list.
   */
  acceptCode?: boolean;
  approvedConsentId?: string;
  /** Ask the person about the code (interactive terminal). Return true to allow. */
  confirmCode?: (report: PluginInstallReport) => Promise<boolean>;
  /** Sees the report before any question, e.g. to print the diff. */
  onReport?: (report: PluginInstallReport) => void;
}

/** Decide runs-code consent from a report. Exported for the sidecar and tests. */
export async function decideCodeConsent(report: PluginInstallReport, options: PluginReviewOptions): Promise<PluginReviewDecision> {
  if (!report.snapshot.runsCode) return {};
  if (report.consentCarriedOver) return { runsCodeAccepted: true };
  const bound = options.approvedConsentId === undefined || options.approvedConsentId === report.consentId;
  if (options.acceptCode === true && bound) return { runsCodeAccepted: true };
  if (options.confirmCode && (await options.confirmCode(report))) return { runsCodeAccepted: true };
  // No yes: install, with the code-running parts off until `plugin allow-code`.
  return { runsCodeAccepted: false };
}

/** The review the CLI and the sidecar pass to install / update. */
export function createPluginInstallReview(options: PluginReviewOptions = {}): PluginReview {
  return async (staged, context) => {
    const report = await inspectStagedPlugin(staged, context);
    options.onReport?.(report);
    await enforceScanGate(`plugin ${report.name}`, report.scan, options);
    return decideCodeConsent(report, options);
  };
}
