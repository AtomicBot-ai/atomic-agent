import type { SkillSource } from "../../skills/skill-loader.js";

/**
 * Local UI state for the TUI "Skills" tab. Lives alongside the rest of
 * `TuiState` and is folded by `skills-reducer.ts` from a small set of
 * `skills_*` actions emitted by the orchestrator and keyboard layer.
 *
 * The tab has two mutually exclusive modes:
 *
 *  - `list`   — table of installed skills with their on/off state.
 *  - `detail` — full SKILL.md body for one selected skill.
 *
 * Mirrors the smaller surface area of `TasksPanelState` — there is no
 * create form (skills are installed from disk via the CLI / `seed-starter-skills`)
 * and no scheduling, so the slice only needs the cursor, the active
 * filter and the optional detail body.
 */
export type SkillsPanelMode = "list" | "detail";

/** Filter buckets surfaced in the list-view header. `all` is the default. */
export type SkillsFilterStatus = "all" | "enabled" | "disabled";

/**
 * Compact row shape rendered by `skills-list.tsx`. The `disabled` flag
 * is plumbed from `SkillRegistry.listAll()` so the list can render
 * disabled rows greyed out without re-reading the config file.
 */
export interface SkillSummaryRow {
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  disabled: boolean;
}

/** Root state slice for the Skills tab. */
export interface SkillsPanelState {
  mode: SkillsPanelMode;
  rows: readonly SkillSummaryRow[];
  cursor: number;
  lastRefreshedAt: number | null;
  loading: boolean;
  autoRefresh: boolean;
  filterStatus: SkillsFilterStatus;
  /** Name of the skill currently shown in detail view, or null. */
  detailName: string | null;
  /** SKILL.md body for the detail view; null while loading or before fetch. */
  detailBody: string | null;
  /** Last error from a toggle / refresh attempt, surfaced in the panel. */
  lastError: string | null;
}

export function createInitialSkillsPanelState(): SkillsPanelState {
  return {
    mode: "list",
    rows: [],
    cursor: 0,
    lastRefreshedAt: null,
    loading: false,
    autoRefresh: true,
    filterStatus: "all",
    detailName: null,
    detailBody: null,
    lastError: null,
  };
}
