import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
  type RunModeName,
  type UserLlmRunModeConfig,
} from "../config/index.js";

/**
 * Writing the run mode is a SINGLE config write that moves two keys:
 * `llm.runMode` and `llm.activeTextProvider`.
 *
 * They have to move together. `resolveRunMode` treats
 * `activeTextProvider` as authoritative and only honours a stored
 * `fusion` while the cloud leg is active, so persisting one without the
 * other leaves a window — or a permanent state — where the file says
 * fusion and the runtime says local. One `writeUserConfigFileSync` plus
 * one `resetConfigCache()` closes it.
 *
 * Lives apart from `persist-llm-provider.ts` because that file is
 * already at the 300-line budget.
 */
export class RunModePersistError extends Error {}

export interface SetRunModeArgs {
  mode: RunModeName;
  /** Provider that must become active for `mode` to hold. */
  primaryProviderId: string;
  /** Optional new dial value; omitted leaves the stored one alone. */
  cloudShare?: number;
}

export function setRunModeInConfig(args: SetRunModeArgs): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = file.llm;
  if (!llm) {
    throw new RunModePersistError(
      "no llm block configured — add a provider first (Manage → LLM)",
    );
  }
  if (!llm.providers.some((p) => p.id === args.primaryProviderId)) {
    throw new RunModePersistError(
      `provider "${args.primaryProviderId}" is not configured`,
    );
  }
  const previous: UserLlmRunModeConfig = llm.runMode ?? {};
  const fusion =
    args.cloudShare === undefined
      ? previous.fusion
      : { ...previous.fusion, cloudShare: args.cloudShare };
  const runMode: UserLlmRunModeConfig = {
    ...previous,
    mode: args.mode,
    ...(fusion ? { fusion } : {}),
  };
  writeUserConfigFileSync(path, {
    ...file,
    llm: {
      ...llm,
      activeTextProvider: args.primaryProviderId,
      runMode,
    },
  });
  resetConfigCache();
}
