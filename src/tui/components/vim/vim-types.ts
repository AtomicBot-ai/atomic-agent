/**
 * Vim mode for the prompt editor (ATO-662): the state the keystroke
 * grammar carries between keys. Everything here is plain data so the
 * grammar stays a set of pure functions over `(state, buffer, key)`.
 */

export type VimMode = "normal" | "insert";

/** The editor's buffer model: the text and a flat caret offset into it. */
export interface VimBuffer {
  readonly value: string;
  readonly cursor: number;
}

/** What `y` / `d` / `c` / `x` last took. `linewise` decides how `p` puts it. */
export interface VimRegister {
  readonly text: string;
  readonly linewise: boolean;
}

export type VimOperator = "d" | "c" | "y";

export interface VimState {
  readonly mode: VimMode;
  /** Digits typed for the next motion or command (`3` in `d3w`). */
  readonly count: string;
  /** An operator waiting for its motion (`d` in `dw`), or `null`. */
  readonly operator: VimOperator | null;
  /** Digits typed before the operator (`2` in `2dw`). */
  readonly operatorCount: string;
  /** A first `g` is waiting for the second one (`gg`). */
  readonly pendingG: boolean;
  readonly register: VimRegister | null;
  /**
   * Buffers to go back to with `u`, newest last. One entry per command,
   * and one per insert session started from NORMAL (so `u` after
   * `ihello<Esc>` removes the whole word, as in vim).
   */
  readonly undo: readonly VimBuffer[];
}

/** Undo depth kept in memory; a prompt never needs more. */
export const VIM_UNDO_LIMIT = 100;

/**
 * Vim mode starts in INSERT: the composer is a chat box first, and the
 * operator who turns vim on still expects to type straight away.
 */
export function createVimState(mode: VimMode = "insert"): VimState {
  return {
    mode,
    count: "",
    operator: null,
    operatorCount: "",
    pendingG: false,
    register: null,
    undo: [],
  };
}

/** Drop any half-typed command (count, operator, `g`), keep the rest. */
export function clearPending(state: VimState): VimState {
  if (
    state.count === "" &&
    state.operator === null &&
    state.operatorCount === "" &&
    !state.pendingG
  ) {
    return state;
  }
  return {
    ...state,
    count: "",
    operator: null,
    operatorCount: "",
    pendingG: false,
  };
}

export function hasPending(state: VimState): boolean {
  return clearPending(state) !== state;
}

/** Remember `buffer` as the state `u` returns to. */
export function pushUndo(state: VimState, buffer: VimBuffer): VimState {
  const undo = [...state.undo, { value: buffer.value, cursor: buffer.cursor }];
  if (undo.length > VIM_UNDO_LIMIT) undo.splice(0, undo.length - VIM_UNDO_LIMIT);
  return { ...state, undo };
}
