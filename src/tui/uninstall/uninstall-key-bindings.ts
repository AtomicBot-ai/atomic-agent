import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";
import { isUninstallConfirmed, type UninstallChoice } from "./uninstall-state.js";

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
  const { state, dispatch } = ctx;
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

  if (flow.step === "desktop") {
    if (key.leftArrow || key.rightArrow || key.tab) {
      dispatch({
        type: "uninstall_desktop_cursor_set",
        cursor: flow.desktopCursor === "keep" ? "delete" : "keep",
      });
      return true;
    }
    if (key.return) answerDesktopQuestion(flow.desktopCursor, ctx);
    // `y`, `n` and every other key are not answers here either.
    return true;
  }

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
    // The word agreed to removing atomic-agent. Wiping a folder the
    // desktop app still runs on is a separate question.
    if (flow.preview?.desktopSharedDir) {
      dispatch({ type: "uninstall_desktop_asked" });
      return true;
    }
    // Nobody was asked about desktop data, so nobody agreed to delete
    // it. The removal re-resolves the plan after the unmount; if a
    // desktop app shows up in that fresh plan, its folder stays.
    startRemoval({ keepDesktopData: true }, ctx);
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

/**
 * Answer the `desktop` step: keep the shared folder (remove only the
 * terminal program) or delete it too. Enter and a click on either
 * button both land here, so the two routes cannot diverge.
 */
export function answerDesktopQuestion(
  answer: "keep" | "delete",
  ctx: UninstallKeyContext,
): void {
  const flow = ctx.state.uninstall;
  if (!flow || flow.step !== "desktop") return;
  ctx.dispatch({ type: "uninstall_desktop_cursor_set", cursor: answer });
  startRemoval({ keepDesktopData: answer === "keep" }, ctx);
}

function startRemoval(choice: UninstallChoice, ctx: UninstallKeyContext): void {
  ctx.dispatch({ type: "uninstall_started" });
  // The callback only flags the post-exit uninstall handoff;
  // `quit_requested` is what unmounts Ink so the handoff is reached.
  ctx.callbacks.onUninstallConfirmed?.(choice);
  ctx.dispatch({ type: "quit_requested" });
}
