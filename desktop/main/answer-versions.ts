/**
 * ATO-2114: the pure half of the "‹ 2/3 ›" switcher under the last reply
 * (renderer/answer-versions.js): what the window may send, and the agent's
 * answers in the shape the window reads.
 *
 * The agent keeps the earlier answers "Regenerate" replaced, for the chat's
 * last question only (src/session/session-previous-replies.ts, ATO-864):
 *   GET  /api/sessions/{id}/previous-replies        the kept answers, oldest first
 *   POST /api/sessions/{id}/restore-previous-reply  put one back ({ index })
 * Its own 404 is an unknown chat (`session_not_found`); an agent without the
 * routes answers its unknown-route 404 with no code, which reads as
 * unsupported, so the window shows no switcher.
 */

export interface KeptAnswer {
  /** Its place in the agent's list, which is what a restore names. */
  index: number;
  /** When the answer was written (the transcript row's `at`). */
  at: number;
}

export type PreviousRepliesAnswer =
  | { ok: true; supported: true; question: string | null; questionStored: boolean; previous: KeptAnswer[] }
  | { ok: false; supported: boolean; code?: string; error: string };

export type RestoreReplyAnswer =
  | { ok: true; supported: true; previousReplies: number }
  | { ok: false; supported: boolean; code?: string; error: string };

/** The body a restore may send: a whole non-negative index, or null. */
export function restoreReplyBody(index: unknown): { index: number } | null {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  return { index };
}

type Refusal = { ok: false; supported: boolean; code?: string; error: string };

function refusal(status: number, body: unknown): Refusal {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const error = record && typeof record.error === "object" && record.error !== null ? (record.error as Record<string, unknown>) : null;
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" && error.code ? error.code : undefined;
  if (status === 404) {
    if (code === "session_not_found" || /session not found/i.test(message)) {
      return { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" };
    }
    return { ok: false, supported: false, error: "This agent version keeps no earlier answers" };
  }
  return { ok: false, supported: true, ...(code ? { code } : {}), error: message || `HTTP ${status}` };
}

/** The agent's answer to GET previous-replies; only the index and time of each kept answer go on. */
export function previousRepliesAnswer(status: number, body: unknown): PreviousRepliesAnswer {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (status < 200 || status >= 300 || !record) return refusal(status, body);
  const previous: KeptAnswer[] = [];
  for (const entry of Array.isArray(record.previous) ? record.previous : []) {
    const e = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    if (!e || typeof e.index !== "number" || !Number.isInteger(e.index) || e.index < 0) continue;
    previous.push({ index: e.index, at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : 0 });
  }
  return {
    ok: true,
    supported: true,
    question: typeof record.question === "string" ? record.question : null,
    questionStored: record.questionStored === true,
    previous,
  };
}

/** The agent's answer to POST restore-previous-reply. */
export function restoreReplyAnswer(status: number, body: unknown): RestoreReplyAnswer {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (status < 200 || status >= 300 || !record) return refusal(status, body);
  const left = record.previousReplies;
  return { ok: true, supported: true, previousReplies: typeof left === "number" && Number.isInteger(left) && left >= 0 ? left : 0 };
}
