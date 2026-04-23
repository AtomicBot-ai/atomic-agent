import type { ToolRegistry } from "../tool-registry.js";
import type { ProfileStore } from "../../memory/profile-store.js";

import { buildProfileSetTool } from "./profile-set.js";
import { buildProfileRemoveTool } from "./profile-remove.js";
import { buildProfileListTool } from "./profile-list.js";

export { buildProfileSetTool } from "./profile-set.js";
export { buildProfileRemoveTool } from "./profile-remove.js";
export { buildProfileListTool } from "./profile-list.js";

export interface RegisterMemoryToolsOptions {
  profileStore: ProfileStore;
  profileEnabled: boolean;
}

/**
 * Register the cross-session memory tools. The profile layer is the only
 * user-facing memory surface; formation happens asynchronously via the
 * reflection runner wired in the runtime bootstrap and does not expose a
 * separate tool.
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
}
