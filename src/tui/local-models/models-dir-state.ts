/**
 * ATO-2504: Models › "models folder", the TUI's copy of the desktop card
 * and of `atomic-agent models dir` (ATO-2106). `F` opens it: it shows
 * where the downloaded models are, takes a new folder (Enter moves every
 * model there), and an empty line goes back to the default folder. Same
 * shape as LM Studio's My Models › Models Directory › Change.
 *
 * The slice lives on the local-models panel (`panel.modelsDir`); the move
 * itself runs in the orchestrator's model-operation turn
 * (models-dir-orchestrator.ts). Pure: types, initial state, reducer.
 */

export interface ModelsDirProgress {
  entry: string;
  index: number;
  total: number;
  /** Bytes copied so far across disks, over the whole move. */
  done?: number;
  size?: number;
}

export interface ModelsDirPanelState {
  /** Where the models are now; null until the agent has said. */
  dir: string | null;
  defaultDir: string | null;
  custom: boolean;
  /** False when the folder's disk is not connected. */
  reachable: boolean;
  /** What the operator typed. */
  draft: string;
  moving: boolean;
  /** Esc during a move asked it to stop. */
  stopping: boolean;
  progress: ModelsDirProgress | null;
  error: string | null;
  note: string | null;
}

export function createInitialModelsDirState(): ModelsDirPanelState {
  return {
    dir: null,
    defaultDir: null,
    custom: false,
    reachable: true,
    draft: "",
    moving: false,
    stopping: false,
    progress: null,
    error: null,
    note: null,
  };
}

export type ModelsDirAction =
  | { type: "local_models_dir_opened" }
  | { type: "local_models_dir_closed" }
  | { type: "local_models_dir_loaded"; dir: string; defaultDir: string; custom: boolean; reachable: boolean }
  | { type: "local_models_dir_draft_changed"; value: string }
  | { type: "local_models_dir_move_started" }
  | { type: "local_models_dir_move_stopping" }
  | { type: "local_models_dir_progress"; progress: ModelsDirProgress }
  | { type: "local_models_dir_move_finished"; note: string }
  | { type: "local_models_dir_move_failed"; error: string };

const TYPES = new Set<string>([
  "local_models_dir_opened",
  "local_models_dir_closed",
  "local_models_dir_loaded",
  "local_models_dir_draft_changed",
  "local_models_dir_move_started",
  "local_models_dir_move_stopping",
  "local_models_dir_progress",
  "local_models_dir_move_finished",
  "local_models_dir_move_failed",
]);

export function isModelsDirAction(action: { type: string }): action is ModelsDirAction {
  return TYPES.has(action.type);
}

/** The next slice for `action`, and whether the panel leaves the folder screen. */
export function reduceModelsDir(
  s: ModelsDirPanelState,
  action: ModelsDirAction,
): { next: ModelsDirPanelState; open?: boolean } {
  switch (action.type) {
    case "local_models_dir_opened":
      return { next: { ...s, error: null, note: null }, open: true };
    case "local_models_dir_closed":
      // A move keeps running (and keeps the screen's slice) until it ends.
      return { next: s.moving ? s : { ...s, draft: "", error: null, note: null }, open: false };
    case "local_models_dir_loaded":
      return { next: { ...s, dir: action.dir, defaultDir: action.defaultDir, custom: action.custom, reachable: action.reachable } };
    case "local_models_dir_draft_changed":
      return { next: { ...s, draft: action.value, error: null } };
    case "local_models_dir_move_started":
      return { next: { ...s, moving: true, stopping: false, progress: null, error: null, note: null } };
    case "local_models_dir_move_stopping":
      return { next: s.moving ? { ...s, stopping: true } : s };
    case "local_models_dir_progress": {
      // A byte line carries no index: keep the model line's position.
      const prev = s.progress;
      const p = action.progress;
      const merged = prev && p.index === 0 ? { ...prev, entry: p.entry, done: p.done, size: p.size } : p;
      return { next: { ...s, progress: merged } };
    }
    case "local_models_dir_move_finished":
      return { next: { ...s, moving: false, stopping: false, progress: null, draft: "", note: action.note } };
    case "local_models_dir_move_failed":
      return { next: { ...s, moving: false, stopping: false, progress: null, error: action.error } };
  }
}

function gb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/** "moving qwen (2 of 5) · 3.1 of 12.0 GB", or "moving your models…" before the first model. */
export function modelsDirProgressLine(p: ModelsDirProgress | null): string {
  if (!p || p.total <= 0) return "moving your models…";
  const bytes = p.size && p.size > 0 && p.done !== undefined ? ` · ${gb(p.done)} of ${gb(p.size)}` : "";
  return `moving ${p.entry} (${p.index} of ${p.total})${bytes}`;
}
