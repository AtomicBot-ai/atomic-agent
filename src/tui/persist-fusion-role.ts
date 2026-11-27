import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
} from "../config/index.js";
import type { FusionRole } from "../config/llm-run-mode-config.js";
import { withFusionRolePin, type FusionRolePin } from "../config/fusion-role-pin.js";
import { readLlmBlockOrDefault } from "../config/llm-provider-commands.js";
import { RunModePersistError } from "./persist-run-mode.js";

/**
 * Persist one Fusion role (`llm.runMode.fusion.roles` and `roleModels`)
 * in one write, without touching the mode or the legs. A provider that
 * is not configured is refused here rather than written, since the
 * parser would refuse the whole file on the next start.
 */
export function setFusionRoleInConfig(role: FusionRole, pin: FusionRolePin): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  if (pin !== null && !llm.providers.some((p) => p.id === pin.providerId)) {
    const ids = llm.providers.map((p) => p.id).join(", ");
    throw new RunModePersistError(
      `provider "${pin.providerId}" is not configured. Configured providers: ${ids || "none"}`,
    );
  }
  const next: UserConfigFile = {
    ...file,
    llm: {
      ...llm,
      runMode: {
        ...llm.runMode,
        fusion: withFusionRolePin(llm.runMode?.fusion, role, pin),
      },
    },
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}
