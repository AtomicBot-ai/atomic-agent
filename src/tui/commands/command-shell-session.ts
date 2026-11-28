import type { TuiState } from "../tui-state.js";

/**
 * The approval owner for a slash command's shell lines (ATO-2441) in a new
 * chat, before its first message made a session. The terminal asks in the
 * chat on screen; with no session yet, the request carries this id, and the
 * approval modal treats it as the chat on screen.
 */
export const NEW_CHAT_COMMAND_SESSION_ID = "slash-command-new-chat";

/** The session id whose approval requests arm the modal: the chat on screen. */
export function approvalSessionOnScreen(state: Pick<TuiState, "session">): string {
  return state.session.sessionId ?? NEW_CHAT_COMMAND_SESSION_ID;
}
