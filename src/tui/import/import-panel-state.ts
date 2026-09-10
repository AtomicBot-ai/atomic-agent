import type { ImportReport } from "../../import/import-report.js";
import {
  defaultSourceDir,
  importSourceToggles,
  type ImportOptionToggle,
  type ImportSourceId,
} from "./import-sources.js";

export { defaultSourceDir } from "./import-sources.js";
export type { ImportSourceId } from "./import-sources.js";

/**
 * Local UI state for the TUI "Import" tab. Lives alongside the rest of
 * `TuiState` and is folded by `import-reducer.ts` from a small set of
 * `import_*` actions emitted by the orchestrator and keyboard layer.
 *
 * The tab is a one-shot migration wizard (no auto-refresh loop) with
 * four mutually exclusive modes:
 *
 *  - `configure` — the option form (source dir + toggles) (the default).
 *  - `preview`   — the dry-run report; awaits a confirm before writing.
 *  - `running`   — the executing-write phase; keys are ignored.
 *  - `done`      — the final report after an executed import.
 *
 * Keeping the data model independent from the importer deps lets the
 * reducer stay pure (no SQLite handle); the orchestrator is the only
 * module that touches `runtime` and the import logic.
 */
export type ImportPanelMode = "configure" | "preview" | "running" | "done";

/** Which field has keyboard focus inside the configure form. */
export type ImportFormFocus =
  "sourceType" | "source" | ImportOptionToggle | "overwrite" | "limit" | "run";

/** Boolean fields toggled with space / left / right inside the form. */
export const IMPORT_TOGGLE_FIELDS = [
  "skills",
  "memory",
  "mcp",
  "sessions",
  "cron",
  "secrets",
  "overwrite",
] as const;

export type ImportToggleField = (typeof IMPORT_TOGGLE_FIELDS)[number];

/**
 * Cycle order for keyboard ↑/↓ navigation across the form fields. The
 * option rows between `source` and `overwrite` are the ones the picked
 * source supports (`import-sources.ts`), so the order is source-dependent.
 */
export function importFocusOrder(source: ImportSourceId): ImportFormFocus[] {
  return [
    "sourceType",
    "source",
    ...importSourceToggles(source).map((meta) => meta.id),
    "overwrite",
    "limit",
    "run",
  ];
}

/**
 * All user input buffers for the configure form. Every option toggle
 * has a buffer whatever the source, so switching sources keeps what the
 * operator ticked; only the rows the source supports are drawn and
 * resolved. `secrets` mirrors the CLI `--migrate-secrets` flag and
 * defaults to `false` so credentials never migrate without an explicit
 * operator opt-in.
 */
export interface ImportFormState {
  source: ImportSourceId;
  sourceDir: string;
  skills: boolean;
  memory: boolean;
  mcp: boolean;
  sessions: boolean;
  cron: boolean;
  secrets: boolean;
  overwrite: boolean;
  /** Raw text buffer; empty means "no limit". Parsed by the orchestrator. */
  limit: string;
  focus: ImportFormFocus;
}

/** Root state slice for the Import tab. */
export interface ImportPanelState {
  mode: ImportPanelMode;
  form: ImportFormState;
  /** Last preview or final report rendered in `preview` / `done` modes. */
  report: ImportReport | null;
  /** True when `report` came from an executed run (`done`), false for a preview. */
  reportExecuted: boolean;
  /** Inline status / error line surfaced under the form. */
  notice: string | null;
  /** Trouble with the destination store, shown under the report. */
  storeWarning: string | null;
}

export function createInitialImportFormState(): ImportFormState {
  return {
    source: "hermes",
    sourceDir: defaultSourceDir("hermes"),
    skills: true,
    memory: true,
    mcp: true,
    sessions: true,
    cron: true,
    secrets: false,
    overwrite: false,
    limit: "",
    focus: "sourceType",
  };
}

export function createInitialImportPanelState(): ImportPanelState {
  return {
    mode: "configure",
    form: createInitialImportFormState(),
    report: null,
    reportExecuted: false,
    notice: null,
    storeWarning: null,
  };
}
