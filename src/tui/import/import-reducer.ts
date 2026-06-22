import type { TuiState } from "../tui-state.js";
import { isImportAction, type ImportAction } from "./import-actions.js";
import {
  defaultSourceDir,
  type ImportPanelState,
} from "./import-panel-state.js";

/**
 * Reducer slice for `state.importPanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer can fall through to other slices.
 *
 * The slice stays small: option resolution, validation and the import
 * itself live in the orchestrator; the reducer only mirrors the wizard
 * phase + form buffers.
 */
export function reduceImportAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isImportAction(action)) return null;
  const panel = state.importPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, importPanel: next };
}

function reducePanel(
  panel: ImportPanelState,
  action: ImportAction,
): ImportPanelState {
  switch (action.type) {
    case "import_form_field_changed":
      return { ...panel, form: { ...panel.form, ...action.patch } };
    case "import_focus_set":
      return { ...panel, form: { ...panel.form, focus: action.focus } };
    case "import_toggled":
      return {
        ...panel,
        form: { ...panel.form, [action.field]: !panel.form[action.field] },
      };
    case "import_source_set": {
      if (action.source === panel.form.source) return panel;
      return {
        ...panel,
        form: {
          ...panel.form,
          source: action.source,
          sourceDir: defaultSourceDir(action.source),
          // OpenClaw v1 has no secrets migration; clear the flag on switch.
          secrets: action.source === "hermes" ? panel.form.secrets : false,
          focus: "sourceType",
        },
      };
    }
    case "import_preview_started":
    case "import_execute_started":
      return {
        ...panel,
        mode: "running",
        notice: null,
      };
    case "import_preview_ready":
      return {
        ...panel,
        mode: "preview",
        report: action.report,
        reportExecuted: false,
        notice: null,
      };
    case "import_execute_done":
      return {
        ...panel,
        mode: "done",
        report: action.report,
        reportExecuted: true,
        notice: null,
      };
    case "import_failed":
      return {
        ...panel,
        mode: "configure",
        notice: action.error,
      };
    case "import_reset":
      return {
        ...panel,
        mode: "configure",
        report: null,
        reportExecuted: false,
        notice: null,
      };
    default:
      return panel;
  }
}
