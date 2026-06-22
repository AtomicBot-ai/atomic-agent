import { homedir } from "node:os";
import { join } from "node:path";

import type { ImportReport } from "../../import/import-report.js";

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
 * Keeping the data model independent from the `HermesImporter` deps lets
 * the reducer stay pure (no SQLite handle); the orchestrator is the only
 * module that touches `runtime` and the import logic.
 */
export type ImportPanelMode = "configure" | "preview" | "running" | "done";

/** Migration source. Each maps to a distinct importer + default dir. */
export type ImportSourceId = "hermes" | "openclaw";

/** Which field has keyboard focus inside the configure form. */
export type ImportFormFocus =
  | "sourceType"
  | "source"
  | "sessions"
  | "cron"
  | "secrets"
  | "overwrite"
  | "limit"
  | "run";

/** Boolean fields toggled with space / left / right inside the form. */
export const IMPORT_TOGGLE_FIELDS = [
  "sessions",
  "cron",
  "secrets",
  "overwrite",
] as const;

export type ImportToggleField = (typeof IMPORT_TOGGLE_FIELDS)[number];

/**
 * Cycle order for keyboard ↑/↓ navigation across the form fields. The
 * `secrets` row only exists for Hermes — OpenClaw v1 does not migrate
 * provider keys — so the order is source-dependent.
 */
export function importFocusOrder(source: ImportSourceId): ImportFormFocus[] {
  const order: ImportFormFocus[] = ["sourceType", "source", "sessions", "cron"];
  if (source === "hermes") order.push("secrets");
  order.push("overwrite", "limit", "run");
  return order;
}

/**
 * All user input buffers for the configure form. `secrets` mirrors the
 * CLI `--migrate-secrets` flag and defaults to `false` so credentials
 * never migrate without an explicit operator opt-in (Hermes only).
 */
export interface ImportFormState {
  source: ImportSourceId;
  sourceDir: string;
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
}

/** Resolve the default state dir for a source, mirroring the CLI defaults. */
export function defaultSourceDir(source: ImportSourceId): string {
  if (source === "openclaw") {
    return process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
  }
  return process.env.HERMES_STATE_DIR ?? join(homedir(), ".hermes");
}

export function createInitialImportFormState(): ImportFormState {
  return {
    source: "hermes",
    sourceDir: defaultSourceDir("hermes"),
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
  };
}
