import type { ToolRegistry } from "../tool-registry.js";
import type { ProfileStore } from "../../memory/profile-store.js";

import { buildProfileSetTool } from "./profile-set.js";
import { buildProfileRemoveTool } from "./profile-remove.js";
import { buildProfileListTool } from "./profile-list.js";
import { buildHistorySearchTool } from "./history-search.js";

export { buildProfileSetTool } from "./profile-set.js";
export { buildProfileRemoveTool } from "./profile-remove.js";
export { buildProfileListTool } from "./profile-list.js";
export { buildHistorySearchTool } from "./history-search.js";

export interface RegisterMemoryToolsOptions {
  profileStore: ProfileStore;
  tracesDir: string;
  historyMaxResults: number;
  tracingEnabled: boolean;
  profileEnabled: boolean;
  historyEnabled: boolean;
}

/**
 * Register the cross-session memory tools. Profile and history layers
 * are toggled independently so entry points can disable one without
 * dropping the other (e.g. sidecar with no on-disk tracing still wants
 * the profile layer).
 */
export function registerMemoryTools(
  registry: ToolRegistry,
  options: RegisterMemoryToolsOptions,
): void {
  if (options.profileEnabled) {
    registry.register(buildProfileSetTool({ store: options.profileStore }));
    registry.register(buildProfileRemoveTool({ store: options.profileStore }));
    registry.register(buildProfileListTool({ store: options.profileStore }));
  }
  if (options.historyEnabled) {
    registry.register(
      buildHistorySearchTool({
        tracesDir: options.tracesDir,
        maxResults: options.historyMaxResults,
        tracingEnabled: options.tracingEnabled,
      }),
    );
  }
}
