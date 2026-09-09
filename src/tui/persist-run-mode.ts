import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
  type UserLlmFusionConfig,
  type RunModeName,
} from "../config/index.js";
import { readLlmBlockOrDefault } from "./persist-llm-provider.js";

export class RunModePersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunModePersistError";
  }
}

export interface RunModeChangeOptions {
  /** Merged over the stored `llm.runMode.fusion` block. */
  readonly fusion?: Partial<UserLlmFusionConfig>;
  /**
   * Mirror of `fusion.workers` onto `localModels.managed.parallel`, so
   * the worker count and the llama-server slot count that lets workers
   * actually run side by side move in the same write.
   */
  readonly managedParallel?: number;
}

export interface SetRunModeArgs extends RunModeChangeOptions {
  readonly mode: RunModeName;
  /**
   * The provider that must be active for `mode` to hold — the
   * orchestrator leg for fusion, the cloud or the local leg otherwise.
   * Written together with the mode, never separately.
   */
  readonly activeTextProvider: string;
}

/**
 * Persist a run-mode change as ONE config write.
 *
 * `resolveRunMode` treats `llm.activeTextProvider` as authoritative and
 * `llm.runMode.mode` as additive. Writing the two keys in separate calls
 * leaves a window — and a crash inside it leaves a file — where the
 * mode says fusion and the active provider says local, so the runtime
 * silently reads the derived mode while the file claims otherwise. One
 * `writeUserConfigFileSync` for both is the invariant; the optional
 * fusion-block merge and the `managed.parallel` mirror ride the same
 * write for the same reason.
 *
 * Lives apart from `persist-llm-provider.ts`, which is past its line
 * budget; `readLlmBlockOrDefault` is the one thing shared.
 */
export function setRunModeInConfig(args: SetRunModeArgs): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  if (!llm.providers.some((p) => p.id === args.activeTextProvider)) {
    throw new RunModePersistError(
      `provider "${args.activeTextProvider}" is not configured`,
    );
  }
  const fusion: UserLlmFusionConfig = { ...llm.runMode?.fusion, ...args.fusion };
  const next: UserConfigFile = {
    ...file,
    llm: {
      ...llm,
      activeTextProvider: args.activeTextProvider,
      runMode: {
        ...llm.runMode,
        mode: args.mode,
        ...(Object.keys(fusion).length > 0 ? { fusion } : {}),
      },
    },
    ...(args.managedParallel === undefined
      ? {}
      : {
          localModels: {
            ...file.localModels,
            managed: { ...file.localModels.managed, parallel: args.managedParallel },
          },
        }),
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}
