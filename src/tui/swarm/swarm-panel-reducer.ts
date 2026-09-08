import type { TuiState } from "../tui-state.js";
import { isSwarmAction, type SwarmAction } from "./swarm-actions.js";
import {
  SWARM_ADD_STEPS,
  SWARM_EDIT_FIELDS,
  createInitialSwarmAddForm,
  type SwarmAddForm,
  type SwarmPanelState,
} from "./swarm-panel-state.js";

/**
 * Reducer slice for `state.swarmPanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer can fall through. Pure: every side effect (config + `.env`
 * writes, channel start/stop) lives in `swarm-orchestrator.ts`.
 */
export function reduceSwarmAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isSwarmAction(action)) return null;
  const panel = state.swarmPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, swarmPanel: next };
}

function reducePanel(panel: SwarmPanelState, action: SwarmAction): SwarmPanelState {
  switch (action.type) {
    case "swarm_synced": {
      // A re-sync must not yank the cursor: rows can grow or shrink
      // while the operator is looking at one.
      const selected = clamp(panel.selected, action.rows.length);
      return { ...panel, rows: action.rows, selected };
    }
    case "swarm_moved": {
      if (panel.mode !== "list") return panel;
      const selected = clamp(panel.selected + action.delta, panel.rows.length);
      if (selected === panel.selected) return panel;
      return { ...panel, selected };
    }
    case "swarm_add_started":
      if (panel.mode !== "list") return panel;
      return { ...panel, mode: "add", form: createInitialSwarmAddForm(), message: null, lastError: null };
    case "swarm_form_kind_set":
      if (panel.mode !== "add" || panel.form.step !== "kind") return panel;
      if (panel.form.kind === action.kind) return panel;
      return { ...panel, form: { ...panel.form, kind: action.kind } };
    case "swarm_form_changed":
      if (panel.mode !== "add") return panel;
      return { ...panel, form: withStepValue(panel.form, action.value) };
    case "swarm_form_next": {
      if (panel.mode !== "add") return panel;
      const i = SWARM_ADD_STEPS.indexOf(panel.form.step);
      const step = SWARM_ADD_STEPS[i + 1];
      // Past the last step the keyboard layer submits; nothing to fold.
      if (step === undefined) return panel;
      // A label is the one thing a bot cannot do without.
      if (panel.form.step === "label" && panel.form.label.trim().length === 0) return panel;
      return { ...panel, form: { ...panel.form, step } };
    }
    case "swarm_form_back": {
      if (panel.mode !== "add") return panel;
      const i = SWARM_ADD_STEPS.indexOf(panel.form.step);
      const step = SWARM_ADD_STEPS[i - 1];
      if (step === undefined) return { ...panel, mode: "list" };
      return { ...panel, form: { ...panel.form, step } };
    }
    case "swarm_edit_started": {
      if (panel.mode !== "list") return panel;
      const row = panel.rows[panel.selected];
      // Primaries are edited in Integrations; only units open here.
      if (!row || row.primary) return panel;
      return { ...panel, mode: "edit", editField: "label", editBuffer: null, message: null, lastError: null };
    }
    case "swarm_edit_field_moved": {
      if (panel.mode !== "edit" || panel.editBuffer !== null) return panel;
      const i = SWARM_EDIT_FIELDS.indexOf(panel.editField);
      const field = SWARM_EDIT_FIELDS[clamp(i + action.delta, SWARM_EDIT_FIELDS.length)]!;
      if (field === panel.editField) return panel;
      return { ...panel, editField: field };
    }
    case "swarm_edit_typing_started":
      if (panel.mode !== "edit" || panel.editBuffer !== null) return panel;
      // Start empty rather than pre-filling: a token is masked everywhere
      // else and seeding the buffer would put it back on screen.
      return { ...panel, editBuffer: "" };
    case "swarm_edit_changed":
      if (panel.mode !== "edit" || panel.editBuffer === null) return panel;
      return { ...panel, editBuffer: action.value };
    case "swarm_remove_started": {
      if (panel.mode !== "list") return panel;
      const row = panel.rows[panel.selected];
      if (!row || row.primary) return panel;
      return { ...panel, mode: "remove", message: null, lastError: null };
    }
    case "swarm_cancelled":
      // In the detail view, cancelling a value being typed is one step;
      // leaving the view is the next.
      if (panel.mode === "edit" && panel.editBuffer !== null) {
        return { ...panel, editBuffer: null };
      }
      if (panel.mode === "list") return panel;
      return { ...panel, mode: "list", editBuffer: null };
    case "swarm_action_started":
      return { ...panel, busy: true };
    case "swarm_action_settled":
      return {
        ...panel,
        busy: false,
        // A finished action closes the wizard / confirm, and a saved
        // value stops typing but stays in the detail view.
        mode: panel.mode === "add" || panel.mode === "remove" ? "list" : panel.mode,
        editBuffer: null,
        ...(panel.mode === "add" && action.error === undefined
          ? { form: createInitialSwarmAddForm() }
          : {}),
        message: action.message ?? null,
        lastError: action.error ?? null,
      };
    case "swarm_message_cleared":
      return { ...panel, message: null, lastError: null };
    default:
      return panel;
  }
}

function withStepValue(form: SwarmAddForm, value: string): SwarmAddForm {
  switch (form.step) {
    case "label":
      return { ...form, label: value };
    case "role":
      return { ...form, role: value };
    case "token":
      return { ...form, token: value };
    case "owner":
      return { ...form, owner: value };
    default:
      return form;
  }
}

/** Clamp an index into `[0, length)`, or 0 when the list is empty. */
function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
