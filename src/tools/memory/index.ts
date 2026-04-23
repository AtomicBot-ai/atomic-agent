import type { ToolRegistry } from "../tool-registry.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { ProfileStore } from "../../memory/profile-store.js";

import { buildProfileSetTool } from "./profile-set.js";
import { buildProfileRemoveTool } from "./profile-remove.js";
import { buildProfileListTool } from "./profile-list.js";
import { buildNotesStoreTool } from "./notes-store.js";
import { buildNotesRecallTool } from "./notes-recall.js";
import { buildNotesForgetTool } from "./notes-forget.js";

export { buildProfileSetTool } from "./profile-set.js";
export { buildProfileRemoveTool } from "./profile-remove.js";
export { buildProfileListTool } from "./profile-list.js";
export { buildNotesStoreTool } from "./notes-store.js";
export { buildNotesRecallTool } from "./notes-recall.js";
export { buildNotesForgetTool } from "./notes-forget.js";

export interface RegisterMemoryToolsOptions {
  profileStore: ProfileStore;
  profileEnabled: boolean;
  /**
   * FTS5-backed freeform notes store. Passed even when `notesEnabled` is
   * false so the SQLite connection can stay owned by `bootstrap` — this
   * mirrors the `profileStore` convention.
   */
  notesStore: MemoryStore;
  notesEnabled: boolean;
  /** Used as the default `k` for `memory.notes.recall`. */
  notesRecallDefaultK: number;
  /** Per-call input ceiling for `memory.notes.store.content`. */
  notesMaxContentChars: number;
}

/**
 * Register the cross-session memory tools. Two families live here:
 *
 *  - `memory.profile.*` — key/value facts auto-rendered into every prompt.
 *    Formation also happens asynchronously via the reflection runner
 *    wired in the runtime bootstrap (no separate tool).
 *  - `memory.notes.*`   — freeform FTS5-searchable notes accessed
 *    explicitly by the agent. Never rendered into the prompt on its
 *    own; invisible unless recalled.
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
  if (options.notesEnabled) {
    registry.register(
      buildNotesStoreTool({
        store: options.notesStore,
        maxContentChars: options.notesMaxContentChars,
      }),
    );
    registry.register(
      buildNotesRecallTool({
        store: options.notesStore,
        defaultK: options.notesRecallDefaultK,
      }),
    );
    registry.register(buildNotesForgetTool({ store: options.notesStore }));
  }
}
