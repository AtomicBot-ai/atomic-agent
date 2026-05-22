import type { ToolRegistry } from "../tool-registry.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import type { LessonStore } from "../../memory/lessons/lesson-store.js";
import type { ProcedureStore } from "../../memory/procedures/procedure-store.js";

import { buildProfileSetTool } from "./profile-set.js";
import { buildProfileRemoveTool } from "./profile-remove.js";
import { buildProfileListTool } from "./profile-list.js";
import { buildProfileHistoryTool } from "./profile-history.js";
import { buildNotesStoreTool } from "./notes-store.js";
import { buildNotesRecallTool } from "./notes-recall.js";
import { buildNotesForgetTool } from "./notes-forget.js";
import { buildLessonsRecallTool } from "./lessons-recall.js";
import { buildProceduresRecallTool } from "./procedures-recall.js";

export { buildProfileSetTool } from "./profile-set.js";
export { buildProfileRemoveTool } from "./profile-remove.js";
export { buildProfileListTool } from "./profile-list.js";
export { buildProfileHistoryTool } from "./profile-history.js";
export { buildNotesStoreTool } from "./notes-store.js";
export { buildNotesRecallTool } from "./notes-recall.js";
export { buildNotesForgetTool } from "./notes-forget.js";
export { buildLessonsRecallTool } from "./lessons-recall.js";
export { buildProceduresRecallTool } from "./procedures-recall.js";

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
  /**
   * Memory-v2 phase 5. `LessonStore` for `memory.lessons.recall`.
   * Optional so callers can opt out (e.g. tests, or when
   * `memory.lessons.enabled=false`). When provided and
   * `lessonsEnabled=true`, the read-only tool is registered.
   */
  lessonStore?: LessonStore;
  lessonsEnabled?: boolean;
  /**
   * Memory-v2 phase 7b. `ProcedureStore` for
   * `memory.procedures.recall`. Optional like `lessonStore`. When
   * provided and `proceduresEnabled=true`, the read-only tool is
   * registered. Read-only invariant 20 is enforced by the fact
   * that the tool only returns `steps[]` text — the runtime never
   * feeds those steps back through `toolRegistry.invoke`.
   */
  procedureStore?: ProcedureStore;
  proceduresEnabled?: boolean;
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
    registry.register(buildProfileHistoryTool({ store: options.profileStore }));
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
  if (options.lessonsEnabled && options.lessonStore) {
    registry.register(buildLessonsRecallTool({ store: options.lessonStore }));
  }
  if (options.proceduresEnabled && options.procedureStore) {
    registry.register(
      buildProceduresRecallTool({ store: options.procedureStore }),
    );
  }
}
