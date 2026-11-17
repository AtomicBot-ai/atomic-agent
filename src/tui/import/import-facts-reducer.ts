import type { FactCandidate } from "../../memory/import-facts/index.js";

import {
  createInitialImportFactsState,
  IMPORT_FACTS_FOCUS_ORDER,
  type ImportFactsFocus,
  type ImportFactsUiState,
} from "./import-facts-state.js";

/**
 * Actions of the facts step (ATO-1627). Prefixed `import_facts_` so the
 * root reducer routes them through the Import slice
 * (`isImportAction`); import-reducer.ts hands them here.
 */
export type ImportFactsAction =
  /** Open the step from the Import form; the runner fills in which models exist. */
  | { type: "import_facts_opened"; localLabel: string | null; cloudProvider: string | null }
  | { type: "import_facts_closed" }
  | { type: "import_facts_focus_moved"; delta: 1 | -1 }
  | { type: "import_facts_kind_toggled" }
  | { type: "import_facts_cloud_toggled" }
  | { type: "import_facts_path_edited"; text: string; backspace: boolean }
  | { type: "import_facts_started"; jobId: string; providerId: string; local: boolean }
  | { type: "import_facts_progress"; progress: ImportFactsUiState["progress"] }
  | { type: "import_facts_found"; candidates: FactCandidate[]; stopped: boolean }
  | { type: "import_facts_cursor_moved"; delta: number }
  | { type: "import_facts_checked_toggled" }
  | { type: "import_facts_saved"; result: NonNullable<ImportFactsUiState["result"]> }
  /** Start, extraction or save failed: back to the form with the reason. */
  | { type: "import_facts_failed"; error: string };

export function isImportFactsAction(action: { type: string }): action is ImportFactsAction {
  return action.type.startsWith("import_facts_");
}

export function reduceImportFacts(s: ImportFactsUiState, a: ImportFactsAction): ImportFactsUiState {
  switch (a.type) {
    case "import_facts_opened":
      return { ...createInitialImportFactsState(), kind: s.kind, path: s.path, localLabel: a.localLabel, cloudProvider: a.cloudProvider };
    case "import_facts_closed":
      return { ...createInitialImportFactsState(), kind: s.kind, path: s.path };
    case "import_facts_focus_moved": {
      const order = IMPORT_FACTS_FOCUS_ORDER;
      const i = Math.max(0, order.indexOf(s.focus));
      return { ...s, focus: order[(i + a.delta + order.length) % order.length] as ImportFactsFocus };
    }
    case "import_facts_kind_toggled":
      return { ...s, kind: s.kind === "claude" ? "chatgpt" : "claude" };
    case "import_facts_cloud_toggled":
      return { ...s, cloud: !s.cloud };
    case "import_facts_path_edited":
      return { ...s, path: a.backspace ? s.path.slice(0, -1) : s.path + a.text, error: null };
    case "import_facts_started":
      return {
        ...s,
        phase: "running",
        jobId: a.jobId,
        readingWith: { providerId: a.providerId, local: a.local },
        progress: { chunksDone: 0, chunksTotal: 0, candidates: 0 },
        error: null,
      };
    case "import_facts_progress":
      return s.phase === "running" ? { ...s, progress: a.progress } : s;
    case "import_facts_found":
      return {
        ...s,
        phase: "review",
        candidates: a.candidates,
        // ATO-1627: all ticked by default; the person unticks what is wrong.
        checked: a.candidates.map((c) => c.id),
        cursor: 0,
        stopped: a.stopped,
      };
    case "import_facts_cursor_moved": {
      const n = s.candidates.length;
      if (n === 0) return s;
      return { ...s, cursor: Math.min(n - 1, Math.max(0, s.cursor + a.delta)) };
    }
    case "import_facts_checked_toggled": {
      const c = s.candidates[s.cursor];
      if (!c) return s;
      const on = s.checked.includes(c.id);
      return { ...s, checked: on ? s.checked.filter((id) => id !== c.id) : [...s.checked, c.id] };
    }
    case "import_facts_saved":
      return { ...s, phase: "done", result: a.result, jobId: null };
    case "import_facts_failed":
      return { ...s, phase: "form", jobId: null, readingWith: null, error: a.error };
    default:
      return s;
  }
}
