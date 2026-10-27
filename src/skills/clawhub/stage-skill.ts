import {
  commitStagedInstall,
  discardStagedInstall,
  enforceScanGate,
  stageSkillFromHub,
  type InstallFromHubResult,
  type ScanGateOptions,
  type StagedSkillInstall,
} from "../hub/install-from-hub.js";
import { ClawHubClient } from "./clawhub-client.js";
import { looksLikeClawHubIdentifier } from "./clawhub-source.js";
import { stageSkillFromClawHub } from "./install-from-clawhub.js";

/**
 * Unified install router across the two skill sources. A staged install
 * is committed/discarded through the same {@link commitStagedInstall} /
 * {@link discardStagedInstall} regardless of origin, so callers only
 * need to pick where to *stage* from.
 *
 * Routing precedence:
 *  1. explicit `source` (TUI rows carry it — a ClawHub browse row may be
 *     a bare slug that does not start with `@`).
 *  2. otherwise infer: `@owner/slug` → ClawHub, else GitHub tap.
 */
export type SkillSourceKind = "github" | "clawhub";

export interface StageSkillOptions {
  identifier: string;
  source?: SkillSourceKind;
  clawHubClient?: ClawHubClient;
}

export function resolveSkillSource(
  identifier: string,
  source?: SkillSourceKind,
): SkillSourceKind {
  if (source) return source;
  return looksLikeClawHubIdentifier(identifier) ? "clawhub" : "github";
}

export async function stageSkill(
  options: StageSkillOptions,
): Promise<StagedSkillInstall> {
  const source = resolveSkillSource(options.identifier, options.source);
  if (source === "clawhub") {
    return stageSkillFromClawHub({
      identifier: options.identifier,
      client: options.clawHubClient,
    });
  }
  return stageSkillFromHub({ identifier: options.identifier });
}

export interface InstallSkillRoutedOptions
  extends StageSkillOptions, ScanGateOptions {
  targetRoot: string;
  force?: boolean;
}

/** One-shot stage → scan gate → commit, used by the CLI. */
export async function installSkillRouted(
  options: InstallSkillRoutedOptions,
): Promise<InstallFromHubResult> {
  const staged = await stageSkill(options);
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
