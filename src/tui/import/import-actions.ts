import type { ImportReport } from "../../import/import-report.js";
import type {
  ImportFormFocus,
  ImportFormState,
  ImportSourceId,
  ImportToggleField,
} from "./import-panel-state.js";

/**
 * All reducer actions specific to the Import tab. The orchestrator and
 * keyboard layer emit these; the reducer folds them into
 * `state.importPanel`. Kept in its own module so the root `TuiAction`
 * union stays small.
 */
export type ImportAction =
  | { type: "import_form_field_changed"; patch: Partial<ImportFormState> }
  | { type: "import_focus_set"; focus: ImportFormFocus }
  | { type: "import_toggled"; field: ImportToggleField }
  /** Switch the migration source; resets the default source dir. */
  | { type: "import_source_set"; source: ImportSourceId }
  /** A preview / execute op started — clear the prior notice. */
  | { type: "import_preview_started" }
  | { type: "import_execute_started" }
  /**
   * Preview / executed report is ready. `storeWarning` carries anything
   * the operator should know about the destination store itself — rows
   * that cannot be read, and so cannot be listed or reconciled — which
   * has no other surface: it is discovered at boot, when the chat is
   * still on the start page and nothing is there to print it.
   */
  | { type: "import_preview_ready"; report: ImportReport; storeWarning?: string }
  /** Executed report is ready — switch to the `done` mode. */
  | { type: "import_execute_done"; report: ImportReport; storeWarning?: string }
  /** Preview / execute failed — surface a notice and return to `configure`. */
  | { type: "import_failed"; error: string }
  /** Return to the configure form, keeping the current form buffers. */
  | { type: "import_reset" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isImportAction(action: { type: string }): action is ImportAction {
  return action.type.startsWith("import_");
}
