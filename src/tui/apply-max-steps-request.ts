import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

export interface MaxStepsTarget {
  getMaxSteps(): number;
  setMaxSteps(maxSteps: number): void;
}

export interface ApplyMaxStepsResult {
  readonly message: string;
  readonly warning: boolean;
}

export function applyMaxStepsRequest(
  maxSteps: number | null,
  target: MaxStepsTarget,
): ApplyMaxStepsResult {
  if (maxSteps === null) {
    return {
      message: `current max_steps: ${target.getMaxSteps()}`,
      warning: false,
    };
  }

  const previous = target.getMaxSteps();
  target.setMaxSteps(maxSteps);
  try {
    const path = getConfig().paths.userConfigFile;
    const current = ensureUserConfigFileSync(path);
    const next = parseUserConfigFile({
      ...current,
      agent: { ...current.agent, maxSteps },
    });
    writeUserConfigFileSync(path, next);
    resetConfigCache();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      message: `max_steps updated to ${maxSteps} (runtime only - failed to persist: ${message})`,
      warning: true,
    };
  }

  return {
    message: `max_steps updated from ${previous} to ${maxSteps}`,
    warning: false,
  };
}
