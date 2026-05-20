/**
 * Barrel exports for the benchmark-campaign config layer. Keep this
 * file pure re-exports — no logic. Runners and scripts import via
 * `from "../../config/index.js"` (note the `.js` extension matching
 * the codebase's ESM convention) so the module surface is auditable
 * from one place.
 */

export {
  CAMPAIGN_PROFILE_NAMES,
  CAMPAIGN_PROFILE_LABELS,
  PROFILE_PROMPT_BUDGETS_MS,
  buildCampaignConfig,
  getProfilePromptBudgetMs,
  seedCampaignConfigJson,
  type CampaignProfileName,
  type CampaignConfigOptions,
} from "./campaign-profiles.js";

export {
  captureEnvironmentSnapshot,
  diffSnapshots,
  readAgentVersion,
  CAMPAIGN_SAMPLING,
  type EnvironmentSnapshot,
  type CaptureOptions,
} from "./environment.js";
