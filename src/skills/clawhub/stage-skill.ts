import {
  commitStagedInstall,
  discardStagedInstall,
  stageSkillFromHub,
  SkillHubInstallError,
  type InstallFromHubResult,
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

export interface InstallSkillRoutedOptions extends StageSkillOptions {
  targetRoot: string;
  force?: boolean;
  /** Allow installing despite a `dangerous` scan verdict. */
  acknowledgeRisk?: boolean;
}

/** One-shot stage → block-on-dangerous → commit, used by the CLI. */
export async function installSkillRouted(
  options: InstallSkillRoutedOptions,
): Promise<InstallFromHubResult> {
  const staged = await stageSkill(options);
  if (staged.scan.verdict === "dangerous" && !options.acknowledgeRisk) {
    await discardStagedInstall(staged);
    throw new SkillHubInstallError(
      `install blocked: ${options.identifier} flagged dangerous by the security scan (use --acknowledge-risk to override)`,
      "dangerous_blocked",
      staged.scan,
    );
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
