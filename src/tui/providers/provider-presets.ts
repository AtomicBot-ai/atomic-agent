/**
 * The preset table lives in the core now
 * (`src/llm/provider/presets/provider-presets.ts`), because the agent's
 * own key rules (`src/llm/provider/provider-key.ts`) read it and the core
 * must not import from `src/tui/`. Re-exported here so the wizard's
 * imports keep working.
 */
export * from "../../llm/provider/presets/provider-presets.js";
