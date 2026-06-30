import type { SkillSource } from "../../skills/skill-loader.js";
import type {
  SkillScanFinding,
  SkillScanVerdict,
  SkillSourceKind,
} from "../../skills/index.js";

/**
 * Local UI state for the TUI "Skills" tab. Lives alongside the rest of
 * `TuiState` and is folded by `skills-reducer.ts` from a small set of
 * `skills_*` actions emitted by the orchestrator and keyboard layer.
 *
 * The tab has three mutually exclusive modes:
 *
 *  - `list`   — table of installed skills with their on/off state.
 *  - `detail` — full SKILL.md body for one selected skill.
 *  - `hub`    — browse/search the skill hub (GitHub taps) and install.
 *
 * Mirrors the smaller surface area of `TasksPanelState` — there is no
 * create form (installed skills come from disk) and no scheduling, so
 * the slice only needs the cursor, the active filter, the optional
 * detail body, and the hub browse/install sub-state.
 */
export type SkillsPanelMode = "list" | "detail" | "hub";

/** Compact catalog row rendered in the hub list. */
export interface HubSkillRow {
  /** Canonical install identifier (`owner/repo[/dir]` or `@owner/slug`). */
  identifier: string;
  name: string;
  description: string;
  version: string;
  /** `owner/repo` (GitHub) or owner handle / `clawhub` (ClawHub). */
  repo: string;
  /** Origin registry — drives install routing and the source badge. */
  source: SkillSourceKind;
  /** All-time downloads (ClawHub only); `undefined` for GitHub taps. */
  downloads?: number;
}

/**
 * Pre-install detail card shown when the operator presses Enter on a hub
 * row (before any download). Carries catalog metadata plus the full
 * SKILL.md fetched lazily from the registry; `body` is null until it
 * resolves, `bodyError` holds a human note when the preview is
 * unavailable (e.g. an ambiguous slug without an owner).
 */
export interface HubCardState {
  identifier: string;
  source: SkillSourceKind;
  name: string;
  repo: string;
  description: string;
  version: string;
  downloads?: number;
  body: string | null;
  bodyError: string | null;
}

/**
 * Number of SKILL.md lines shown at once in the pre-install card body.
 * Shared by the reducer (to clamp the scroll offset) and the component
 * (the render window) so the two never disagree on the bounds.
 */
export const HUB_CARD_BODY_WINDOW = 24;

/**
 * Pending install confirmation. Opened when a staged skill's security
 * scan returns a non-`ok` verdict so the operator can review the
 * findings before committing the install.
 */
export interface SkillInstallConfirmState {
  identifier: string;
  verdict: SkillScanVerdict;
  findings: readonly SkillScanFinding[];
}

/**
 * Pending uninstall confirmation. Opened on `d` over a list row so a
 * stray keystroke cannot delete a skill directory. `isStarter` flags a
 * bundled starter that the seeder re-copies on the next boot — the modal
 * surfaces that so the operator can pick `disable` instead.
 */
export interface SkillRemoveConfirmState {
  name: string;
  source: SkillSource;
  isStarter: boolean;
  submitting: boolean;
  error: string | null;
}

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
  /** Hub browse/search results. */
  hubRows: readonly HubSkillRow[];
  /** Cursor within `hubRows`. */
  hubCursor: number;
  /** Current hub search query. */
  hubQuery: string;
  /** Whether the hub search input is in edit mode (capturing keystrokes). */
  hubSearchEditing: boolean;
  /** True while a hub browse/search request is in flight. */
  hubLoading: boolean;
  /** Last hub browse/search error, surfaced in the hub view. */
  hubError: string | null;
  /** True while an install is committing. */
  installing: boolean;
  /** Last hub install error, surfaced on the card/hub view (not the chat feed). */
  installError: string | null;
  /** Open install confirmation modal, or null. */
  installConfirm: SkillInstallConfirmState | null;
  /** Open pre-install skill card, or null. */
  hubCard: HubCardState | null;
  /** True while the card's SKILL.md is being fetched. */
  hubCardLoading: boolean;
  /** First visible SKILL.md line in the card body (scroll offset). */
  cardScroll: number;
  /** Open uninstall confirmation modal, or null. */
  removeConfirm: SkillRemoveConfirmState | null;
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
    hubRows: [],
    hubCursor: 0,
    hubQuery: "",
    hubSearchEditing: false,
    hubLoading: false,
    hubError: null,
    installing: false,
    installError: null,
    installConfirm: null,
    hubCard: null,
    hubCardLoading: false,
    cardScroll: 0,
    removeConfirm: null,
  };
}
