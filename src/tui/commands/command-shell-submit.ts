import type { WhileBusySubmitMode } from "../../config/index.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { canAcceptMessage, type TuiState } from "../tui-state.js";

type Dispatch = (action: TuiAction) => void;
type SendWhileBusy = (text: string, mode: WhileBusySubmitMode, dispatch: Dispatch, callbacks: TuiAppCallbacks) => void;

/**
 * Send an own command whose shell lines are still running (ATO-2441).
 * From an idle chat it looks like a sent message at once (`running`), so
 * nothing else is sent in between and the approval modal opens over a
 * busy composer, as for a model's call. A line that is not allowed or
 * fails stops it: nothing is sent and the composer comes back. While a
 * turn runs, the finished text goes the way a typed message would
 * (steer or queue).
 */
export function submitWhenShellDone(
  pending: Promise<string>,
  name: string,
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
  sendWhileBusy: SendWhileBusy,
): void {
  const idle = canAcceptMessage(state);
  dispatch({ type: "system_message", text: `/${name}: running its shell lines first.` });
  if (idle) dispatch({ type: "message_submitted" });
  void pending.then(
    (text) => {
      if (text.trim().length === 0) throw new Error(`command /${name} rendered an empty message`);
      if (idle) callbacks.onMessageSubmitted(text);
      else sendWhileBusy(text, state.whileBusyMode, dispatch, callbacks);
    },
  ).catch((error: unknown) => {
    const why = error instanceof Error ? error.message : String(error);
    dispatch({ type: "command_not_sent", text: `/${name} was not sent: ${why}`, resetRun: idle });
    callbacks.onSkillsRefreshRequested?.();
  });
}
