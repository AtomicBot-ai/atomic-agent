/**
 * The projection and its constants moved to `src/session/context-usage.ts`
 * so the runtime can stamp the same snapshot onto `SessionState` without
 * reaching into the TUI. This re-export keeps the TUI-side import paths
 * (reducers, panels, tests) stable.
 */
export {
  CONVERSATION_SECTION_LABEL,
  EMPTY_CONTEXT_USAGE,
  contextUsageFromPrompt,
} from "../session/context-usage.js";
