export {
  DEFAULT_TAPS,
  formatSkillIdentifier,
  looksLikeHubIdentifier,
  parseSkillIdentifier,
  parseTapRepo,
  SkillIdentifierError,
} from "./skill-hub-source.js";
export type { SkillIdentifier, SkillTap } from "./skill-hub-source.js";

export { GithubSkillClient, GithubSkillError } from "./github-skill-client.js";
export type {
  DownloadedSkillFile,
  GithubSkillClientOptions,
  GithubSkillErrorCode,
  RemoteSkillManifestRef,
  SkillHubClient,
} from "./github-skill-client.js";

export {
  browseHub,
  browseTap,
  filterHubEntries,
  searchHub,
} from "./skill-hub-catalog.js";
export type { HubSkillEntry } from "./skill-hub-catalog.js";

export {
  formatSkillsShIdentifier,
  looksLikeSkillsShIdentifier,
  parseSkillsShResponse,
  searchSkillsSh,
  SKILLS_SH_API_BASE,
  SKILLS_SH_PREFIX,
  SkillsShClient,
  SkillsShError,
} from "./skills-sh-client.js";
export type { SkillsShClientOptions, SkillsShSkill } from "./skills-sh-client.js";
export { resolveSkillsShIdentifier, stageSkillFromSkillsSh } from "./skills-sh-install.js";
export type { StageSkillsShOptions } from "./skills-sh-install.js";

export { scanSkillFiles, summarizeScan } from "./skill-security-scanner.js";
export type {
  ScannableFile,
  SkillScanFinding,
  SkillScanResult,
  SkillScanSeverity,
  SkillScanVerdict,
} from "./skill-security-scanner.js";

export { scanSkillDir } from "./scan-skill-dir.js";

export {
  commitStagedInstall,
  discardStagedInstall,
  enforceScanGate,
  installSkillFromHub,
  scanApprovalFromIds,
  scanIdOf,
  SkillHubInstallError,
  stageSkillFromHub,
} from "./install-from-hub.js";
export type {
  CommitInstallOptions,
  InstallFromHubOptions,
  InstallFromHubResult,
  ScanGateOptions,
  SkillHubInstallErrorCode,
  StagedSkillInstall,
  StageSkillOptions,
} from "./install-from-hub.js";
