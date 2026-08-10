import type { ApprovalLevel } from "../approval/approval-level.js";
import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Persist the approval ladder position (`agent.approvalLevel`) into the
 * user config file, then invalidate the global config cache so the next
 * `getConfig()` sees it. Mirrors the other `persist-*` helpers: read →
 * merge → validate → write → reset.
 *
 * The caller is responsible for hot-applying the change to the live
 * runtime via `runtime.setApprovalLevel`; this only durably records
 * the choice so future runs boot with it.
 */
export function persistApprovalLevel(level: ApprovalLevel): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    agent: { ...prev.agent, approvalLevel: level },
  };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
