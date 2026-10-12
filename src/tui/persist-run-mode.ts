import {
  FUSION_WORKERS_MAX,
  FUSION_WORKERS_MIN,
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
  type UserLlmFusionConfig,
  type RunModeName,
} from "../config/index.js";
import { readLlmBlockOrDefault } from "../config/llm-provider-commands.js";

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
 * Uses the provider block owned by config; run-mode state is written
 * together with its active-provider pin.
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
  const fusion: UserLlmFusionConfig = repinFusionLegs(
    llm.runMode?.fusion,
    args.fusion,
  );
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
            managed: {
              ...file.localModels.managed,
              parallel: args.managedParallel,
            },
          },
        }),
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}

/**
 * Merge a fusion-block change over the stored one. A leg's model pin
 * names a model of that leg's provider, so moving the leg to another
 * provider drops the stored pin unless the change sets a new one —
 * otherwise the new provider is displayed and priced as the old model.
 * A model pin on a leg that was never pinned to a provider is left
 * alone, the same rule `scrubRunModeProviderPins` follows.
 */
function repinFusionLegs(
  stored: UserLlmFusionConfig | undefined,
  change: Partial<UserLlmFusionConfig> | undefined,
): UserLlmFusionConfig {
  const fusion: UserLlmFusionConfig = { ...stored, ...change };
  if (
    stored?.orchestratorProvider !== undefined &&
    change?.orchestratorProvider !== undefined &&
    change.orchestratorProvider !== stored.orchestratorProvider &&
    change.orchestratorModel === undefined
  ) {
    delete fusion.orchestratorModel;
  }
  if (
    stored?.workerProvider !== undefined &&
    change?.workerProvider !== undefined &&
    change.workerProvider !== stored.workerProvider &&
    change.workerModel === undefined
  ) {
    delete fusion.workerModel;
  }
  return fusion;
}

/**
 * Persist the worker count without touching the mode: `llm.runMode.fusion.workers`
 * and `localModels.managed.parallel` in one write. The two are one fact
 * seen from two sides — how many workers the orchestrator may fan out,
 * and how many llama-server slots exist for them to run in — so they
 * must not be able to disagree. Valid off the fusion route too: the
 * count is remembered for the next time fusion is picked.
 */
export function setFusionWorkersInConfig(workers: number): void {
  if (
    !Number.isInteger(workers) ||
    workers < FUSION_WORKERS_MIN ||
    workers > FUSION_WORKERS_MAX
  ) {
    throw new RunModePersistError(
      `workers must be an integer ${FUSION_WORKERS_MIN}-${FUSION_WORKERS_MAX}, got ${workers}`,
    );
  }
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const next: UserConfigFile = {
    ...file,
    llm: {
      ...llm,
      runMode: { ...llm.runMode, fusion: { ...llm.runMode?.fusion, workers } },
    },
    localModels: {
      ...file.localModels,
      managed: { ...file.localModels.managed, parallel: workers },
    },
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}
