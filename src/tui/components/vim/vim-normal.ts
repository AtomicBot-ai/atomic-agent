import { enterInsert, INSERT_KEYS, type InsertEntry, type ModeStep } from "./vim-insert.js";
import {
  MOTION_KEYS,
  resolveMotion,
  type MotionTarget,
  type VimMotion,
} from "./vim-motions.js";
import {
  applyOperator,
  countLinesRange,
  deleteChars,
  put,
  rangeOf,
  type VimRange,
} from "./vim-operators.js";
import { charClass, clampNormal, lineEnd } from "./vim-text.js";
import {
  clearPending,
  pushUndo,
  type VimBuffer,
  type VimOperator,
  type VimState,
} from "./vim-types.js";

/**
 * The NORMAL-mode grammar (ATO-662): one printable key in, the next
 * state and buffer out. Supported: counts, `h j k l w b e 0 $ ^ gg G`,
 * `i a I A o O`, `x dd dw cw cc D C yy p P u`, and every operator with
 * every motion above. Anything else is swallowed and clears a
 * half-typed command, as vim does — it is never typed into the buffer.
 */

/** A count past this is a typo, not an intent; it also bounds `999p`. */
const MAX_COUNT = 1000;

const OPERATOR_KEYS: ReadonlySet<string> = new Set(["d", "c", "y"]);

export function normalKey(state: VimState, buffer: VimBuffer, ch: string): ModeStep {
  if (/^[1-9]$/.test(ch) || (ch === "0" && state.count !== "")) {
    return { state: { ...state, count: state.count + ch }, buffer };
  }
  if (state.pendingG) {
    const rest = { ...state, pendingG: false };
    if (ch === "g") return motion(rest, buffer, "gg");
    return { state: clearPending(rest), buffer };
  }
  if (ch === "g") return { state: { ...state, pendingG: true }, buffer };
  if (MOTION_KEYS.has(ch)) return motion(state, buffer, ch as VimMotion);
  if (OPERATOR_KEYS.has(ch)) return operatorKey(state, buffer, ch as VimOperator);
  // An operator followed by anything but a motion or itself is cancelled.
  if (state.operator !== null) return { state: clearPending(state), buffer };
  const { n } = counts(state);
  const idle = clearPending(state);
  if (INSERT_KEYS.has(ch)) return enterInsert(idle, buffer, ch as InsertEntry);
  switch (ch) {
    case "x": {
      const res = deleteChars(buffer, n);
      if (!res) return { state: idle, buffer };
      return {
        state: { ...pushUndo(idle, buffer), register: res.register },
        buffer: res.buffer,
      };
    }
    case "D":
    case "C":
      return toLineEnd(idle, buffer, ch === "D" ? "d" : "c", n);
    case "p":
    case "P": {
      if (!idle.register) return { state: idle, buffer };
      return {
        state: pushUndo(idle, buffer),
        buffer: put(buffer, idle.register, ch === "p", n),
      };
    }
    case "u":
      return undo(idle, buffer, n);
    default:
      return { state: idle, buffer };
  }
}

function counts(state: VimState): { n: number; hasCount: boolean } {
  const op = state.operatorCount === "" ? 1 : Number(state.operatorCount);
  const own = state.count === "" ? 1 : Number(state.count);
  return {
    n: Math.min(MAX_COUNT, op * own),
    hasCount: state.operatorCount !== "" || state.count !== "",
  };
}

function motion(state: VimState, buffer: VimBuffer, m: VimMotion): ModeStep {
  const { value, cursor } = buffer;
  const { n, hasCount } = counts(state);
  const idle = clearPending(state);
  const op = state.operator;
  // `cw` on a word is `ce`: vim leaves the blank after the word alone.
  const changeWord = op === "c" && m === "w" && charClass(value[cursor]) !== 0;
  const effective: VimMotion = changeWord ? "e" : m;
  const target = changeWord
    ? changeWordTarget(value, cursor, n)
    : resolveMotion(value, cursor, m, n, hasCount);
  if (!target) return { state: idle, buffer };
  if (op === null) {
    return { state: idle, buffer: { value, cursor: clampNormal(value, target.cursor) } };
  }
  let range = rangeOf(value, cursor, target);
  if (!range) return { state: idle, buffer };
  // `dw` on a line's last word stops at the line's end instead of
  // joining the next line onto this one.
  const end = lineEnd(value, cursor);
  if (effective === "w" && range.to > end && end > cursor) {
    range = { ...range, to: end };
  }
  return runOperator(idle, buffer, op, range);
}

/**
 * `cw` / `3cw`: like `e`, except that on a word's last character the
 * first count already ends there — `cw` on the `o` of `foo` changes
 * just the `o`, where `e` would run on to the end of the next word.
 */
function changeWordTarget(value: string, cursor: number, n: number): MotionTarget {
  const atWordEnd = charClass(value[cursor + 1]) !== charClass(value[cursor]);
  const remaining = atWordEnd ? n - 1 : n;
  const end =
    remaining > 0
      ? (resolveMotion(value, cursor, "e", remaining, false)?.cursor ?? cursor)
      : cursor;
  return { cursor: end, linewise: false, inclusive: true };
}

function operatorKey(state: VimState, buffer: VimBuffer, op: VimOperator): ModeStep {
  if (state.operator === op) {
    const { n } = counts(state);
    const range = countLinesRange(buffer.value, buffer.cursor, n);
    return runOperator(clearPending(state), buffer, op, range);
  }
  if (state.operator !== null) return { state: clearPending(state), buffer };
  return {
    state: { ...state, operator: op, operatorCount: state.count, count: "" },
    buffer,
  };
}

function runOperator(
  state: VimState,
  buffer: VimBuffer,
  op: VimOperator,
  range: VimRange,
): ModeStep {
  const res = applyOperator(buffer, op, range);
  let next: VimState = { ...state, register: res.register ?? state.register };
  if (op !== "y") next = pushUndo(next, buffer);
  if (res.insert) next = { ...next, mode: "insert" };
  return { state: next, buffer: res.buffer };
}

/** `D` / `C`: to the end of the line (`3D` reaches two lines further). */
function toLineEnd(
  state: VimState,
  buffer: VimBuffer,
  op: "d" | "c",
  n: number,
): ModeStep {
  const target = resolveMotion(buffer.value, buffer.cursor, "$", n, n > 1);
  const range = target ? rangeOf(buffer.value, buffer.cursor, target) : null;
  if (range) return runOperator(state, buffer, op, range);
  // Nothing to the right (an empty line): `C` still starts typing.
  return op === "c" ? enterInsert(state, buffer, "i") : { state, buffer };
}

function undo(state: VimState, buffer: VimBuffer, n: number): ModeStep {
  if (state.undo.length === 0) return { state, buffer };
  const keep = Math.max(0, state.undo.length - n);
  const restored = state.undo[keep];
  if (!restored) return { state, buffer };
  return {
    state: { ...state, undo: state.undo.slice(0, keep) },
    buffer: {
      value: restored.value,
      cursor: clampNormal(restored.value, restored.cursor),
    },
  };
}
