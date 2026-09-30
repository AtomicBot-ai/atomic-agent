import { randomUUID } from "node:crypto";

/**
 * U27: the session a chat turn goes to.
 *
 * Given no `session_id`, the agent's OpenAI route DERIVES one from the
 * system prompt and the first user message (src/http/openai-session-id.ts,
 * a hermes-agent convention meant for stateless OpenAI clients): the same
 * opening prompt always resumes the same session. The desktop sends only the
 * newest message per turn, so on a new chat that "first message" is simply
 * what the person typed, and a New session opened with the same question as
 * an older one landed back in the older one, history and all.
 *
 * So the desktop never lets the agent derive: a turn on an existing chat
 * carries that chat's id, and the first turn of a new chat carries a fresh
 * one. An explicit id the agent has never seen creates a new session under
 * that id, and the stream's `session_id` frame echoes it back to the window
 * exactly as before.
 */
export function newChatSessionId(): string {
  return randomUUID();
}

export function chatSessionIdFor(sessionId: string | undefined | null): string {
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : newChatSessionId();
}
