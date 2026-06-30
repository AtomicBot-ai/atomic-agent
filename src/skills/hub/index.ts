export {
  DEFAULT_TAPS,
  formatSkillIdentifier,
  looksLikeHubIdentifier,
  parseSkillIdentifier,
  parseTapRepo,
  SkillIdentifierError,
} from "./skill-hub-source.js";
export type { SkillIdentifier, SkillTap } from "./skill-hub-source.js";

export {
  GithubSkillClient,
  GithubSkillError,
} from "./github-skill-client.js";
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
  scanSkillFiles,
  summarizeScan,
} from "./skill-security-scanner.js";
export type {
  ScannableFile,
  SkillScanFinding,
  SkillScanResult,
  SkillScanSeverity,
  SkillScanVerdict,
} from "./skill-security-scanner.js";

export {
  commitStagedInstall,
  discardStagedInstall,
  installSkillFromHub,
  SkillHubInstallError,
  stageSkillFromHub,
} from "./install-from-hub.js";
export type {
  CommitInstallOptions,
  InstallFromHubOptions,
  InstallFromHubResult,
  SkillHubInstallErrorCode,
  StagedSkillInstall,
  StageSkillOptions,
} from "./install-from-hub.js";
