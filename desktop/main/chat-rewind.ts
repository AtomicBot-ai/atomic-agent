/**
 * ATO-1056 / ATO-1058 — the pure half of "Roll back here", "Edit" and "Fork
 * from here" (renderer/chat-rewind.js): what the window may ask for, and the
 * agent's answer in the shape the window reads.
 *
 * The agent's routes (src/http/route-session-rewind.ts):
 *   POST /api/sessions/{id}/rewind/preview   what a rollback would change
 *   POST /api/sessions/{id}/rewind           files first, then the chat
 *   POST /api/sessions/{id}/fork             a new chat through that question's answer
 * Each takes `{ priorQuestions, expectText }`, the question by its position
 * and its text. Its own 404 is an unknown chat (`session_not_found`); an agent
 * without the routes answers its unknown-route 404 with no code, which reads
 * as unsupported so the window hides the buttons.
 */

export type RewindRoute = "rewind/preview" | "rewind" | "fork";

export type RewindAnswer =
  | { ok: true; supported: true; data: Record<string, unknown> }
  | { ok: false; supported: boolean; code?: string; error: string };

/** The body the window may send: a non-negative whole position and the question's text. */
export function rewindRequestBody(priorQuestions: unknown, expectText: unknown): { priorQuestions: number; expectText: string } | null {
  if (typeof priorQuestions !== "number" || !Number.isInteger(priorQuestions) || priorQuestions < 0) return null;
  if (typeof expectText !== "string" || !expectText.trim()) return null;
  return { priorQuestions, expectText };
}

/** The agent's answer to one of the routes, as the window reads it. */
export function rewindAnswer(status: number, body: unknown): RewindAnswer {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const error = record && typeof record.error === "object" && record.error !== null ? (record.error as Record<string, unknown>) : null;
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" && error.code ? error.code : undefined;
  if (status >= 200 && status < 300 && record) return { ok: true, supported: true, data: record };
  if (status === 404) {
    if (code === "session_not_found" || /session not found/i.test(message)) {
      return { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" };
    }
    return { ok: false, supported: false, error: "This agent version cannot roll back or fork a chat" };
  }
  return { ok: false, supported: true, ...(code ? { code } : {}), error: message || `HTTP ${status}` };
}
