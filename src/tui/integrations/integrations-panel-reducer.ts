import type { TuiState } from "../tui-state.js";
import {
  isIntegrationsAction,
  type IntegrationsAction,
} from "./integrations-actions.js";
import type { IntegrationsPanelState } from "./integrations-panel-state.js";

/**
 * Reducer slice for `state.integrationsPanel`. Returns an updated
 * `TuiState` when the action belongs to this slice, `null` otherwise so
 * the root reducer can fall through. Pure: every side effect (`.env`
 * writes, live MCP mount/unmount) lives in
 * `integrations-orchestrator.ts`.
 */
export function reduceIntegrationsAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isIntegrationsAction(action)) return null;
  const panel = state.integrationsPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, integrationsPanel: next };
}

function reducePanel(
  panel: IntegrationsPanelState,
  action: IntegrationsAction,
): IntegrationsPanelState {
  switch (action.type) {
    case "integrations_synced": {
      // A re-sync must not yank the cursor: rows can be re-ordered or
      // shrink while the operator is looking at one, and jumping the
      // selection under them loses their place mid-edit.
      const selected = clamp(panel.selected, action.rows.length);
      const fieldCount = action.rows[selected]?.fields.length ?? 0;
      return {
        ...panel,
        rows: action.rows,
        selected,
        selectedField: clamp(panel.selectedField, fieldCount),
      };
    }
    case "integrations_moved": {
      if (panel.mode !== "list") return panel;
      const selected = clamp(panel.selected + action.delta, panel.rows.length);
      if (selected === panel.selected) return panel;
      return { ...panel, selected, selectedField: 0 };
    }
    case "integrations_field_moved": {
      if (panel.mode !== "detail") return panel;
      const count = panel.rows[panel.selected]?.fields.length ?? 0;
      const selectedField = clamp(panel.selectedField + action.delta, count);
      if (selectedField === panel.selectedField) return panel;
      return { ...panel, selectedField };
    }
    case "integrations_opened":
      if (panel.rows.length === 0) return panel;
      return { ...panel, mode: "detail", selectedField: 0 };
    case "integrations_closed":
      return { ...panel, mode: "list", editBuffer: "" };
    case "integrations_edit_started":
      if (panel.mode !== "detail") return panel;
      // Start empty rather than pre-filling the current value: a secret
      // is masked everywhere else, and seeding the buffer with it would
      // put the key back on screen in plain text.
      return { ...panel, mode: "edit", editBuffer: "" };
    case "integrations_edit_changed":
      if (panel.mode !== "edit") return panel;
      return { ...panel, editBuffer: action.value };
    case "integrations_edit_cancelled":
      return { ...panel, mode: "detail", editBuffer: "" };
    case "integrations_action_started":
      return { ...panel, busy: true };
    case "integrations_action_settled":
      return {
        ...panel,
        busy: false,
        mode: panel.mode === "edit" ? "detail" : panel.mode,
        editBuffer: "",
        message: action.message ?? null,
        lastError: action.error ?? null,
      };
    case "integrations_message_cleared":
      return { ...panel, message: null, lastError: null };
    default:
      return panel;
  }
}

/** Clamp an index into `[0, length)`, or 0 when the list is empty. */
function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
