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
} from "./skill-catalog.js";
export type { BuildCatalogOptions } from "./skill-catalog.js";

export { runSkillScript, SkillScriptError } from "./skill-script-runner.js";
export type {
  RunSkillScriptParams,
  SkillScriptOutcome,
} from "./skill-script-runner.js";

export {
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
