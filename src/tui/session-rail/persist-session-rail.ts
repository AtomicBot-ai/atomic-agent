import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";

/**
 * Persist the rail's manual session order into `tui.sessionRail.order`,
 * then invalidate the config cache so the next `getConfig()` sees it.
 * Same read → merge → validate → write → reset shape as the other
 * `persist-*` helpers. Only the orchestrator calls this, from the
 * move callback — never the reducer or a render path.
 */
export function persistSessionRailOrder(order: readonly string[]): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    tui: { ...prev.tui, sessionRail: { order: [...order] } },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}

/** The persisted order, `[]` while the operator has never arranged the rail. */
export function readSessionRailOrder(): readonly string[] {
  return getConfig().tui.sessionRail.order;
}
