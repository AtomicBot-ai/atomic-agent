import type { Key } from "ink";

import type { ImportFactsCommand } from "./import-facts-runner.js";
import type { ImportFactsAction } from "./import-facts-reducer.js";
import type { ImportFactsUiState } from "./import-facts-state.js";

/**
 * Keys of the facts step (ATO-1627). Every key is consumed while the
 * step is open, so nothing leaks into the chat composer.
 *
 * - form: ↑/↓ move, space/Enter flip the export kind and the cloud row,
 *   letters type the path, Enter on "start" starts, Esc closes.
 * - running: Esc stops (what was found so far is kept and listed).
 * - review: ↑/↓ move, space ticks/unticks, Enter saves the ticked ones,
 *   Esc closes without saving.
 * - done: Enter or Esc closes.
 */
export function handleImportFactsKey(
  input: string,
  key: Key,
  s: ImportFactsUiState,
  dispatch: (action: ImportFactsAction) => void,
  run: (cmd: ImportFactsCommand) => void,
): true {
  if (s.phase === "running") {
    if (key.escape && s.jobId) run({ kind: "stop", jobId: s.jobId });
    return true;
  }
  if (s.phase === "done") {
    if (key.return || key.escape) run({ kind: "close", jobId: null });
    return true;
  }
  if (s.phase === "review") {
    if (key.escape) run({ kind: "close", jobId: s.jobId });
    else if (key.upArrow) dispatch({ type: "import_facts_cursor_moved", delta: -1 });
    else if (key.downArrow) dispatch({ type: "import_facts_cursor_moved", delta: 1 });
    else if (input === " ") dispatch({ type: "import_facts_checked_toggled" });
    else if (key.return && s.jobId) run({ kind: "save", jobId: s.jobId, approvedIds: s.checked });
    return true;
  }
  // form
  if (key.escape) {
    run({ kind: "close", jobId: null });
    return true;
  }
  if (key.upArrow || key.downArrow) {
    dispatch({ type: "import_facts_focus_moved", delta: key.upArrow ? -1 : 1 });
    return true;
  }
  const flip = input === " " || key.return || key.leftArrow || key.rightArrow;
  if (s.focus === "kind" && flip) dispatch({ type: "import_facts_kind_toggled" });
  else if (s.focus === "cloud" && flip) dispatch({ type: "import_facts_cloud_toggled" });
  else if (s.focus === "start" && key.return) {
    run({ kind: "start", facts: { kind: s.kind, path: s.path, cloud: s.cloud, cloudProvider: s.cloudProvider } });
  } else if (s.focus === "path") {
    if (key.return) dispatch({ type: "import_facts_focus_moved", delta: 1 });
    else if (key.backspace || key.delete) dispatch({ type: "import_facts_path_edited", text: "", backspace: true });
    else if (input && !key.ctrl && !key.meta) dispatch({ type: "import_facts_path_edited", text: input, backspace: false });
  }
  return true;
}
