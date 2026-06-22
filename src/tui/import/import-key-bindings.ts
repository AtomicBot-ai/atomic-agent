import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  importFocusOrder,
  IMPORT_TOGGLE_FIELDS,
  type ImportFormFocus,
  type ImportFormState,
  type ImportToggleField,
} from "./import-panel-state.js";

export interface ImportTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Import tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true` when
 * the key was consumed.
 *
 * Navigation deliberately uses ↑/↓ (not Tab) so the global Tab cycler
 * keeps moving between dashboard tabs — the form never traps the
 * operator. Letter keys type into the focused text field (`source` /
 * `limit`); space / ←/→ flip the boolean toggles; Enter on the `run`
 * row triggers the dry-run preview.
 */
export function handleImportTabKey(
  input: string,
  key: Key,
  ctx: ImportTabKeyContext,
): boolean {
  const { state } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "import") return false;
  const panel = state.importPanel;
  if (panel.mode === "running") return true; // busy — swallow every key
  if (panel.mode === "preview") return handlePreviewKey(input, key, ctx);
  if (panel.mode === "done") return handleDoneKey(input, key, ctx);
  return handleConfigureKey(input, key, ctx, panel.form);
}

function handleConfigureKey(
  input: string,
  key: Key,
  ctx: ImportTabKeyContext,
  form: ImportFormState,
): boolean {
  const { dispatch, callbacks } = ctx;
  if (key.ctrl && key.return) {
    callbacks.onImportPreview?.(form);
    return true;
  }
  if (key.downArrow) {
    dispatch({ type: "import_focus_set", focus: focusAfter(form, 1) });
    return true;
  }
  if (key.upArrow) {
    dispatch({ type: "import_focus_set", focus: focusAfter(form, -1) });
    return true;
  }
  if (key.return) {
    if (form.focus === "run") {
      callbacks.onImportPreview?.(form);
      return true;
    }
    if (form.focus === "sourceType") {
      dispatch({ type: "import_source_set", source: otherSource(form) });
      return true;
    }
    if (isToggleFocus(form.focus)) {
      dispatch({ type: "import_toggled", field: form.focus });
      return true;
    }
    dispatch({ type: "import_focus_set", focus: focusAfter(form, 1) });
    return true;
  }
  if (form.focus === "sourceType") {
    if (input === " " || key.leftArrow || key.rightArrow) {
      dispatch({ type: "import_source_set", source: otherSource(form) });
      return true;
    }
    return true; // swallow stray letters on the source-type row
  }
  if (isToggleFocus(form.focus)) {
    if (input === " " || key.leftArrow || key.rightArrow) {
      dispatch({ type: "import_toggled", field: form.focus });
      return true;
    }
    return true; // swallow stray letters on a toggle row
  }
  // Text fields: `source` and `limit`.
  if (form.focus === "source" || form.focus === "limit") {
    if (key.backspace || key.delete) {
      applyTextEdit(form, "", true, dispatch);
      return true;
    }
    if (input && input.length > 0 && !key.ctrl && !key.meta) {
      applyTextEdit(form, input, false, dispatch);
      return true;
    }
  }
  return true;
}

function handlePreviewKey(
  input: string,
  key: Key,
  ctx: ImportTabKeyContext,
): boolean {
  const { dispatch, callbacks, state } = ctx;
  const lower = input.toLowerCase();
  if (lower === "y" || key.return) {
    callbacks.onImportExecute?.(state.importPanel.form);
    return true;
  }
  if (lower === "e" || lower === "n" || key.escape) {
    dispatch({ type: "import_reset" });
    return true;
  }
  return true;
}

function handleDoneKey(_input: string, key: Key, ctx: ImportTabKeyContext): boolean {
  if (key.return || key.escape) {
    ctx.dispatch({ type: "import_reset" });
    return true;
  }
  return true;
}

function applyTextEdit(
  form: ImportFormState,
  text: string,
  isBackspace: boolean,
  dispatch: (action: TuiAction) => void,
): void {
  const field = form.focus === "source" ? "sourceDir" : "limit";
  const current = form[field];
  const next = isBackspace ? current.slice(0, -1) : current + text;
  dispatch({
    type: "import_form_field_changed",
    patch: { [field]: next } as Partial<ImportFormState>,
  });
}

function isToggleFocus(focus: ImportFormFocus): focus is ImportToggleField {
  return (IMPORT_TOGGLE_FIELDS as readonly string[]).includes(focus);
}

function otherSource(form: ImportFormState): ImportFormState["source"] {
  return form.source === "hermes" ? "openclaw" : "hermes";
}

function focusAfter(form: ImportFormState, delta: 1 | -1): ImportFormFocus {
  const order = importFocusOrder(form.source);
  const idx = order.indexOf(form.focus);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + delta + order.length) % order.length;
  return order[next] ?? "sourceType";
}
