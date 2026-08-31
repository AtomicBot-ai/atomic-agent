export {
  parseSkillFile,
  SkillManifestError,
  SKILL_PLATFORMS,
} from "./skill-manifest.js";
export type {
  SkillManifest,
  ParsedSkillFile,
  SkillPlatform,
} from "./skill-manifest.js";

export { loadSkills, isSkillEligibleForPlatform } from "./skill-loader.js";
export type {
  SkillRecord,
  SkillSource,
  LoadSkillsOptions,
  LoadSkillsResult,
} from "./skill-loader.js";

export { SkillRegistry, SkillNotFoundError } from "./skill-registry.js";
export type { SkillChangeListener } from "./skill-registry.js";

export {
  buildSkillCatalog,
  formatSkillCatalogLine,
  SKILL_CATALOG_CHARS_PER_TOKEN,
  DEFAULT_CATALOG_MAX_CHARS,
} from "./skill-catalog.js";
export type { BuildCatalogOptions } from "./skill-catalog.js";

export { runSkillScript, SkillScriptError } from "./skill-script-runner.js";
export type {
  RunSkillScriptParams,
  SkillScriptOutcome,
} from "./skill-script-runner.js";

export {
  listStarterSkillNames,
  seedStarterSkillsIfMissing,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";
export type {
  SeedStarterSkillsLogger,
  SeedStarterSkillsOptions,
  SeedStarterSkillsResult,
} from "./seed-starter-skills.js";

export {
  installSkill,
  uninstallSkill,
  SkillInstallError,
} from "./skill-installer.js";
export type {
  InstallSkillOptions,
  InstallSkillResult,
} from "./skill-installer.js";

export {
  browseHub,
  browseTap,
  commitStagedInstall,
  DEFAULT_TAPS,
  filterHubEntries,
  discardStagedInstall,
  formatSkillIdentifier,
  GithubSkillClient,
  GithubSkillError,
  installSkillFromHub,
  looksLikeHubIdentifier,
  parseSkillIdentifier,
  parseTapRepo,
  scanSkillFiles,
  searchHub,
  SkillHubInstallError,
  SkillIdentifierError,
  stageSkillFromHub,
  summarizeScan,
} from "./hub/index.js";
export type {
  DownloadedSkillFile,
  GithubSkillClientOptions,
  HubSkillEntry,
  InstallFromHubOptions,
  InstallFromHubResult,
  RemoteSkillManifestRef,
  ScannableFile,
  SkillHubClient,
  SkillIdentifier,
  SkillScanFinding,
  SkillScanResult,
  SkillScanVerdict,
  SkillTap,
  StagedSkillInstall,
} from "./hub/index.js";

export {
  browseClawHub,
  ClawHubClient,
  ClawHubError,
  ClawHubIdentifierError,
  formatClawHubIdentifier,
  installSkillRouted,
  looksLikeClawHubIdentifier,
  mergeRegistryVerdict,
  parseClawHubIdentifier,
  resolveSkillSource,
  searchClawHub,
  stageSkill,
  stageSkillFromClawHub,
} from "./clawhub/index.js";
export type {
  ClawHubBrowseOptions,
  ClawHubClientOptions,
  ClawHubScanStatus,
  ClawHubSkillDetail,
  ClawHubSkillRef,
  ClawHubSkillSort,
  ClawHubSkillSummary,
  InstallSkillRoutedOptions,
  SkillSourceKind,
  StageSkillOptions,
} from "./clawhub/index.js";
