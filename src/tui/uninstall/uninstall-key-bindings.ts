import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";
import { isUninstallConfirmed } from "./uninstall-state.js";

type UninstallKeyContext = Pick<AppKeyContext, "state" | "dispatch" | "callbacks">;

/**
 * Keys for the uninstall ladder.
 *
 * Two rules carry the whole design. The first: `y` does nothing, on any
 * screen — the reflex answer to a confirm dialog must not be an answer
 * here. The second: on the last screen, Enter only means something once
 * the word has actually been typed, and every other printable key is
 * text going into that field rather than a command. There is no key
 * that skips a step and no key that means "yes" twice in a row.
 */
export function handleUninstallKey(
  input: string,
  key: Key,
  ctx: UninstallKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const flow = state.uninstall;
  if (!flow) return false;
  const close = (): void => dispatch({ type: "uninstall_closed" });

  // Nothing is answerable once the app is on its way down — including
  // Ctrl+C, which at that point would leave a half-removed install.
  if (flow.step === "closing") return true;

  // Ctrl+C closes the dialog and hands the key on, same contract the
  // session dialog has: "stop everything" must never be swallowed.
  if (key.ctrl && input === "c") {
    close();
    return false;
  }
  if (key.escape) {
    close();
    return true;
  }
  if (key.ctrl || key.meta) return false;

  if (flow.step === "loading" || flow.step === "failed") return true;

  if (flow.step === "review") {
    if (key.leftArrow || key.rightArrow || key.tab) {
      dispatch({
        type: "uninstall_cursor_set",
        cursor: flow.cursor === "cancel" ? "continue" : "cancel",
      });
      return true;
    }
    if (key.return) {
      // An empty plan has nothing to continue to, so Enter closes.
      if (flow.cursor === "continue" && (flow.preview?.rows.length ?? 0) > 0) {
        dispatch({ type: "uninstall_review_accepted" });
      } else {
        close();
      }
      return true;
    }
    return true;
  }

  // `confirm`: a text field with one accepted value.
  if (key.return) {
    if (!isUninstallConfirmed(flow.typed)) return true;
    dispatch({ type: "uninstall_started" });
    // The callback only flags the post-exit uninstall handoff;
    // `quit_requested` is what unmounts Ink so the handoff is reached.
    callbacks.onUninstallConfirmed?.();
    dispatch({ type: "quit_requested" });
    return true;
  }
  if (key.backspace || key.delete) {
    dispatch({ type: "uninstall_typed_set", typed: flow.typed.slice(0, -1) });
    return true;
  }
  if (
    input &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow
  ) {
    // Capped at a little over the word's length: a paste of a whole
    // paragraph should not become a field the operator has to clear
    // one backspace at a time.
    const typed = `${flow.typed}${input}`.slice(0, 32);
    dispatch({ type: "uninstall_typed_set", typed });
    return true;
  }
  return true;
}
