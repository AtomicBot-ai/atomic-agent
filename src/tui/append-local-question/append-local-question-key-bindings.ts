import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";
import type { TuiState } from "../tui-state.js";

type AppendLocalKeyContext = Pick<AppKeyContext, "state" | "dispatch" | "callbacks">;

/** What a keystroke means to the fallback question, if anything. */
export type AppendLocalHotkey = "keep" | "off" | "later";

/**
 * The chords the last-resort fallback question answers to (ATO-2760).
 * The same letters as the approval card's approve and deny
 * (`APPROVAL_CHORDS`), for the same reason: the composer stays live
 * under the question, so a bare letter is text, and a message that
 * starts with "now..." must not turn the fallback off for good.
 */
export const APPEND_LOCAL_CHORDS = { keep: "y", off: "d" } as const;

/**
 * Resolve a keystroke against the fallback question (ATO-1461). Only
 * ctrl chords decide; Esc puts the question off until the next start,
 * and only with an empty composer, because Esc is also the editor's
 * "clear the draft" key. Everything else is ordinary typing.
 *
 * Consulted by both the app key handler (to act) and the composer's
 * `claimKey` guard (to stand down), so the two never double-handle.
 */
export function appendLocalHotkey(state: TuiState, input: string, key: Key): AppendLocalHotkey | null {
  // The trust question goes first, and a pending approval owns the same
  // chords (approve / deny), so the approval wins while both are up.
  if (!state.appendLocalPrompt || state.projectTrustPrompt || state.pendingApproval) return null;
  if (key.escape) return state.inputValue.length > 0 ? null : "later";
  if (!key.ctrl || key.meta) return null;
  const lower = input.toLowerCase();
  if (lower === APPEND_LOCAL_CHORDS.keep) return "keep";
  if (lower === APPEND_LOCAL_CHORDS.off) return "off";
  return null;
}

/**
 * ATO-1461: keep the local model as the last resort or turn it off (both
 * remembered); Esc closes until the next start. Chords only since
 * ATO-2760; other input passes through to the composer.
 */
export function handleAppendLocalKey(input: string, key: Key, ctx: AppendLocalKeyContext): boolean {
  const hotkey = appendLocalHotkey(ctx.state, input, key);
  if (hotkey === null) return false;
  if (hotkey !== "later") ctx.callbacks.onAppendLocalAnswered?.(hotkey);
  ctx.dispatch({ type: "append_local_closed" });
  return true;
}
