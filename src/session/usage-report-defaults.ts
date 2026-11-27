import { join } from "node:path";

import { getConfig, resolveStateDir } from "../config/index.js";
import { resolveLlmConfig, type LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import { spendDayKey } from "./daily-spend.js";
import { readUsageHistory } from "./usage-history-parse.js";
import { USAGE_HISTORY_FILE_NAME, type UsageHistoryFile } from "./usage-history-types.js";

/**
 * What every reader of the usage report (the CLI, the TUI's `/usage`,
 * `GET /api/usage`) takes from the live config (ATO-2442). None of it
 * throws: a config that cannot be read means midnight UTC as the day
 * start and no "your cloud model" reference (the default one is used).
 */
export interface UsageReferenceProviders {
  providers: readonly LlmProviderConfigEntry[];
  activeTextProvider?: string;
}

/** The history in the resolved state dir; missing or damaged reads as empty. */
export function readDefaultUsageHistory(stateDir?: string): UsageHistoryFile {
  return readUsageHistory(join(stateDir ?? resolveStateDir(), USAGE_HISTORY_FILE_NAME));
}

/** Today's spend day under `llm.costTracking.dailyResetHourUtc`. */
export function usageToday(now: number = Date.now()): string {
  let resetHour = 0;
  try {
    resetHour = getConfig().llm?.costTracking?.dailyResetHourUtc ?? 0;
  } catch {
    // A broken config must not hide the history.
  }
  return spendDayKey(now, resetHour);
}

export function usageReferenceProviders(): UsageReferenceProviders {
  try {
    const llm = resolveLlmConfig(getConfig());
    return { providers: llm.providers, activeTextProvider: llm.activeTextProvider };
  } catch {
    return { providers: [] };
  }
}
