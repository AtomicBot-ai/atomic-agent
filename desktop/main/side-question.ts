/**
 * ATO-1152 — the side question's request, checked before it goes to the
 * agent (side-question-ipc.ts). No Electron here, so the Node checks load it
 * (test/side-question.test.mjs).
 */

/** The agent's limit on a side question (src/runtime/side-question.ts). */
export const SIDE_QUESTION_MAX_CHARS = 4000;

/** The checked request, or the words for why it cannot be asked. */
export function sideQuestionRequest(
  payload: unknown,
): { ok: true; question: string; sessionId?: string } | { ok: false; error: string } {
  const { question, sessionId } = (payload ?? {}) as { question?: unknown; sessionId?: unknown };
  const text = typeof question === "string" ? question.trim() : "";
  if (!text) return { ok: false, error: "Nothing to ask" };
  if (text.length > SIDE_QUESTION_MAX_CHARS) return { ok: false, error: `too long (over ${SIDE_QUESTION_MAX_CHARS} characters)` };
  // A chat the agent has not saved yet (`waiting-…`) has nothing to read.
  const id = typeof sessionId === "string" && sessionId && !sessionId.startsWith("waiting-") ? sessionId : undefined;
  return { ok: true, question: text, ...(id ? { sessionId: id } : {}) };
}
