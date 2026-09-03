import { Box, Text } from "ink";
import { type ReactElement } from "react";
import { useTransientStatus } from "../hooks/use-transient-status.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import {
  MouseTarget,
  useMouseCommands,
  type MouseContextValue,
} from "../mouse/mouse-context.js";
import { handleEditorSubmit } from "../submit-handler.js";
import { theme } from "../theme/theme.js";

interface ChatTryAgainButtonProps {
  /** The message source, resent verbatim — byte for byte what was sent before. */
  readonly text: string;
  /** How long `sent` stays up before the label reverts. */
  readonly revertAfterMs?: number;
}

/** Idle / just-resent. The badge is also the double-click guard. */
type TryAgainStatus = "idle" | "sent";

const DEFAULT_REVERT_MS = 2_000;

const LABELS: Readonly<Record<TryAgainStatus, string>> = {
  idle: "[try again]",
  sent: "[sent]",
};

/**
 * Re-run `text` exactly as if it had been typed into the composer and
 * submitted with Enter.
 *
 * **One submit path.** Everything goes through `handleEditorSubmit`, the
 * function Enter calls, so a re-run inherits whatever routing the
 * operator has configured instead of inventing a third behaviour: idle
 * starts a turn; while a turn is running `tui.whileBusySubmit` (Ctrl+T)
 * decides between steering the text into the turn in flight and parking
 * it in the queue. The same rule covers the odd cases for free — a
 * message that happens to read as a slash command runs as one, because
 * that is what typing it would do, and a second interpretation of the
 * same text is exactly how two submit paths drift apart.
 *
 * **The composer draft survives.** Every landing that path dispatches
 * blanks `inputValue` — `startNewRun`, `message_queued` and
 * `message_steered` all do — which would silently eat a half-written
 * message the operator had not sent yet. The draft is snapshotted before
 * the submit and written back after it, so a re-run costs a turn and
 * nothing else. Restoring the buffer alone is enough: a draft that would
 * also need slash-palette state restored cannot reach this handler at
 * all, because `TuiApp` raises the mouse floor to `MOUSE_LAYER_MODAL`
 * while the palette is open and this button sits on the base layer.
 */
export function resubmitChatMessage(
  text: string,
  mouse: MouseContextValue,
): void {
  // Read state at click time, not render time: the handler fires outside
  // React's render pass and the turn may have started or finished since
  // the frame that painted the button.
  const state = mouse.getState();
  const draft = state.inputValue;
  handleEditorSubmit(text, state, mouse.dispatch, mouse.callbacks);
  if (draft.length > 0) {
    mouse.dispatch({ type: "input_changed", value: draft });
  }
}

/**
 * The per-message "run that again" affordance, beside `[copy]`.
 *
 * **Only user messages get one**, which is `chat-log.tsx`'s call to
 * make, not this component's — but the reasoning belongs next to the
 * code it explains. A user message is a command someone gave the agent,
 * so re-running it is a real intent: the model wandered off, a file
 * changed, a tool was down. An assistant message is the agent's own
 * prose; sending it back would open a turn whose prompt is the previous
 * answer, which is not "try again" in any sense an operator means. A
 * system message is TUI runtime output — queue listings, turn-failed
 * lines — and re-sending one as a prompt is worse than nonsense. The
 * one system notice that carries the button — "Agent stopped by user",
 * via `ChatMessage.retryText` — is no exception: what it resends is the
 * aborted turn's *user* prompt, never its own text. Asking
 * the model to have another go at the *same* question is a different
 * feature (it has to drop the last turn, not append one) and it is not
 * this button.
 *
 * **Why a badge when the click already changes the screen.** Often it
 * does not. A steered message is not rendered until the loop applies it
 * at the next step boundary (`steer_applied`), which can be seconds
 * away, so a click with no feedback reads as a dead button and gets
 * clicked again. `[sent]` closes that gap and doubles as the guard:
 * clicks are ignored while it is up, so the double-click a terminal
 * reports as two presses cannot open two turns.
 *
 * **Without a mouse provider** (component tests, `--no-mouse`) it still
 * renders, exactly like `[copy]` — a legible hint that the affordance is
 * there when the mouse is on — but registers no target.
 */
export function ChatTryAgainButton({
  text,
  revertAfterMs = DEFAULT_REVERT_MS,
}: ChatTryAgainButtonProps): ReactElement {
  const mouse = useMouseCommands();
  const [status, flash] = useTransientStatus<TryAgainStatus>(
    "idle",
    revertAfterMs,
  );

  const label = (
    <Text color={theme.colors.muted} dimColor={status === "idle"}>
      {LABELS[status]}
    </Text>
  );

  // One space off `[copy]`, on the same row: the footer stays a single
  // line whatever the role, so `estimateMessageHeight` does not have to
  // branch — and an under-counted row is not a cosmetic bug in Ink 7,
  // which paints an over-tall frame's later lines over its earlier ones
  // rather than clipping.
  return (
    <Box marginLeft={1} flexDirection="row">
      {mouse ? (
        <MouseTarget
          flexShrink={0}
          onMouse={(hit) => {
            if (!isPrimaryPress(hit.event)) return false;
            // Claim the press either way — the click landed on this
            // button, and letting it fall through would hand it to the
            // viewport wheel target behind the chat log.
            if (status !== "idle") return true;
            resubmitChatMessage(text, mouse);
            flash("sent");
            return true;
          }}
        >
          {label}
        </MouseTarget>
      ) : (
        label
      )}
    </Box>
  );
}
