import type { IntegrationStatusLevel } from "../../integrations/index.js";

/**
 * UI state for the "Integrations" tab — the one place an operator puts
 * third-party credentials (Composio today; Telegram and Discord next).
 *
 * The orchestrator pushes rows in through `integrations_synced`; the
 * reducer only folds actions and never touches `.env`, config or the
 * runtime.
 */

/** One field as rendered in the detail view. */
export interface IntegrationFieldRow {
  key: string;
  label: string;
  /** Already masked when the field is a secret — never the raw value. */
  display: string;
  present: boolean;
  help?: string;
}

/** One integration as rendered in the list view. */
export interface IntegrationRow {
  id: string;
  label: string;
  summary: string;
  level: IntegrationStatusLevel;
  detail?: string;
  docsUrl?: string;
  appliesLive: boolean;
  fields: readonly IntegrationFieldRow[];
}

export type IntegrationsPanelMode = "list" | "detail" | "edit";

export interface IntegrationsPanelState {
  mode: IntegrationsPanelMode;
  rows: readonly IntegrationRow[];
  /** Index into `rows`. Clamped by the reducer, never out of range. */
  selected: number;
  /** Index into the selected row's `fields`, used in detail/edit. */
  selectedField: number;
  /**
   * In-progress value for the field being edited. Held in plain text
   * because the operator has to be able to see what they typed before
   * committing; it is masked the moment it is saved and is never
   * logged or persisted anywhere but `<stateDir>/.env`.
   */
  editBuffer: string;
  /** True while a save / clear is in flight. */
  busy: boolean;
  message: string | null;
  lastError: string | null;
}

export function createInitialIntegrationsPanelState(): IntegrationsPanelState {
  return {
    mode: "list",
    rows: [],
    selected: 0,
    selectedField: 0,
    editBuffer: "",
    busy: false,
    message: null,
    lastError: null,
  };
}

/** The row under the cursor, or `undefined` when the list is empty. */
export function selectedRow(
  state: IntegrationsPanelState,
): IntegrationRow | undefined {
  return state.rows[state.selected];
}

/** The field under the cursor in detail/edit mode. */
export function selectedField(
  state: IntegrationsPanelState,
): IntegrationFieldRow | undefined {
  return selectedRow(state)?.fields[state.selectedField];
}
