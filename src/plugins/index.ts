export { detectPluginFormat, readPluginManifest, parseManifestObject, PluginManifestError, PLUGIN_NAME_RE } from "./plugin-manifest.js";
export type { DetectedPlugin } from "./plugin-manifest.js";
export { readPluginBundle, bundleRunsCode } from "./plugin-bundle.js";
export type {
  PluginAgentEntry,
  PluginAuthor,
  PluginBundle,
  PluginCommandEntry,
  PluginFormat,
  PluginManifest,
  PluginSkillEntry,
} from "./plugin-types.js";
export {
  installedPluginDir,
  isPartDisabled,
  listEnabledPlugins,
  pluginDataDir,
  pluginsRoot,
  readPluginState,
  updatePluginRecord,
  writePluginState,
} from "./plugin-store.js";
export type { InstalledPluginRecord, PluginSourceRecord, PluginStateFile } from "./plugin-store.js";
export {
  commitStagedPlugin,
  discardStagedPlugin,
  installPluginFromDir,
  PluginInstallError,
  removePlugin,
  reviewAndCommit,
  setPluginEnabled,
  setPluginPartEnabled,
  stagePluginCopy,
} from "./plugin-install.js";
export type {
  CommitPluginOptions,
  PluginReview,
  PluginReviewContext,
  PluginReviewDecision,
  ReviewAndCommitOptions,
  StagedPlugin,
} from "./plugin-install.js";
export { listEnabledPluginSkills, loadEnabledPlugins, resetPluginCache } from "./plugin-runtime.js";
export type { LoadedPlugin, LoadedPlugins, PluginSkillDir } from "./plugin-runtime.js";
export { loadPluginMcpServers, expandVars, uniqueName } from "./plugin-mcp.js";
export type { PluginMcpServers } from "./plugin-mcp.js";
export { listPluginSubagents, parseSubagentFile } from "./plugin-subagents.js";
export type { PluginSubagentProfile } from "./plugin-subagents.js";
export {
  listPluginCommands,
  parseCommandFile,
  renderCommandTemplate,
  renderPluginCommand,
  shortCommandAliases,
  splitCommandArgs,
} from "./plugin-commands.js";
export type { CommandTemplateVars, ParsedCommandFile, PluginCommand } from "./plugin-commands.js";
export {
  checkGitUrl,
  findMarketplaceFile,
  MARKETPLACE_FILES,
  MARKETPLACE_NAME_RE,
  MarketplaceError,
  parseEntrySource,
  parseMarketplaceJson,
  parseMarketplaceObject,
  readMarketplaceFile,
} from "./marketplace-manifest.js";
export type { MarketplaceEntry, MarketplaceManifest, MarketplacePluginSource } from "./marketplace-manifest.js";
export { createDefaultPluginFetcher, githubUrl } from "./marketplace-fetch.js";
export type { PluginFetcher } from "./marketplace-fetch.js";
export {
  describeMarketplaceSource,
  marketplaceCheckoutDir,
  marketplacesRoot,
  readMarketplaceLock,
  writeMarketplaceLock,
} from "./marketplace-store.js";
export type { MarketplaceLockFile, MarketplaceRecord, MarketplaceSourceRecord } from "./marketplace-store.js";
export {
  addMarketplace,
  applyEntryManifest,
  installMarketplacePlugin,
  listMarketplaces,
  loadMarketplace,
  looksLikePluginSpec,
  materialiseEntry,
  parseMarketplaceInput,
  parsePluginSpec,
  removeMarketplace,
  resolveMarketplacePlugin,
  updateMarketplaces,
  updatePlugin,
} from "./marketplace.js";
export type {
  AddMarketplaceResult,
  LoadedMarketplace,
  MarketplaceDeps,
  MarketplaceInstallOptions,
  MarketplaceInstallResult,
  PluginUpdateOptions,
  PluginUpdateResult,
  RemoveMarketplaceResult,
  ResolvedMarketplacePlugin,
  UpdateMarketplaceResult,
} from "./marketplace.js";
