import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";

/**
 * What the rail remembers between runs: the manual order and the
 * pinned ids. One value, because a pin rewrites both — pinning moves
 * the row into the block, and the block is ordered by `order`.
 */
export interface SessionRailLayout {
  readonly order: readonly string[];
  readonly pinned: readonly string[];
}

/**
 * Persist the rail's layout into `tui.sessionRail`, then invalidate the
 * config cache so the next `getConfig()` sees it. Same read → merge →
 * validate → write → reset shape as the other `persist-*` helpers.
 * Only the orchestrator calls this, from the move and pin callbacks —
 * never the reducer or a render path.
 */
export function persistSessionRailLayout(layout: SessionRailLayout): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    tui: {
      ...prev.tui,
      sessionRail: { order: [...layout.order], pinned: [...layout.pinned] },
    },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}

/** The persisted layout: `[]`/`[]` while the operator has never touched the rail. */
export function readSessionRailLayout(): SessionRailLayout {
  const { order, pinned } = getConfig().tui.sessionRail;
  return { order, pinned };
}
