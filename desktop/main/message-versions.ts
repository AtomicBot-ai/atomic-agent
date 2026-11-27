/**
 * ATO-2470: the pure half of the "‹ 2/3 ›" switchers on edited messages and
 * on answers to any question (renderer/message-versions.js): what the window
 * may send, and the agent's answers in the shape the window reads.
 *
 * The agent keeps every version of every question
 * (src/session/session-message-versions.ts):
 *   GET  /api/sessions/{id}/message-versions   the questions that have another version
 *   POST /api/sessions/{id}/switch-version     put one in the chat ({ priorQuestions, expectText?, ref })
 * Its own 404 is an unknown chat (`session_not_found`); an agent without the
 * routes answers its unknown-route 404 with no code, which reads as
 * unsupported, so the window falls back to the last-answer switcher (answer-versions.ts).
 */

export interface VersionEntry {
  /** What a switch names. */
  ref: string;
  /** The question the version starts with. */
  text: string;
  at: number;
  /** When its answer was written; null when it has none. */
  answerAt: number | null;
  keptAt: number;
}

export interface QuestionVersionsView {
  priorQuestions: number;
  live: { text: string; at: number; answerAt: number | null } | null;
  versions: VersionEntry[];
  compacted: boolean;
}

export type MessageVersionsAnswer =
  | { ok: true; supported: true; questions: QuestionVersionsView[] }
  | { ok: false; supported: boolean; code?: string; error: string };

export type SwitchVersionAnswer =
  | { ok: true; supported: true; text: string; versions: number }
  | { ok: false; supported: boolean; code?: string; error: string };

type Refusal = { ok: false; supported: boolean; code?: string; error: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function refusal(status: number, body: unknown): Refusal {
  const error = asRecord(asRecord(body)?.error);
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" && error.code ? error.code : undefined;
  if (status === 404) {
    if (code === "session_not_found" || /session not found/i.test(message)) {
      return { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" };
    }
    return { ok: false, supported: false, error: "This agent version keeps no earlier versions of a message" };
  }
  return { ok: false, supported: true, ...(code ? { code } : {}), error: message || "The agent could not do it" };
}

/** The body a switch may send, or null when the window named no real version. */
export function switchVersionBody(
  priorQuestions: unknown,
  expectText: unknown,
  ref: unknown,
): { priorQuestions: number; expectText?: string; ref: string } | null {
  if (typeof priorQuestions !== "number" || !Number.isInteger(priorQuestions) || priorQuestions < 0) return null;
  if (typeof ref !== "string" || !/^[br]\d+$/.test(ref)) return null;
  return { priorQuestions, ref, ...(typeof expectText === "string" ? { expectText } : {}) };
}

function readVersion(value: unknown): VersionEntry | null {
  const v = asRecord(value);
  if (!v || typeof v.ref !== "string" || !/^[br]\d+$/.test(v.ref) || typeof v.text !== "string") return null;
  return { ref: v.ref, text: v.text, at: finite(v.at) ?? 0, answerAt: finite(v.answerAt), keptAt: finite(v.keptAt) ?? 0 };
}

function readQuestion(value: unknown): QuestionVersionsView | null {
  const q = asRecord(value);
  if (!q || typeof q.priorQuestions !== "number" || !Number.isInteger(q.priorQuestions) || q.priorQuestions < 0) return null;
  const live = asRecord(q.live);
  const versions = (Array.isArray(q.versions) ? q.versions : []).map(readVersion).filter((v): v is VersionEntry => v !== null);
  if (versions.length === 0) return null;
  return {
    priorQuestions: q.priorQuestions,
    live: live && typeof live.text === "string" ? { text: live.text, at: finite(live.at) ?? 0, answerAt: finite(live.answerAt) } : null,
    versions,
    compacted: q.compacted === true,
  };
}

/** The agent's answer to GET message-versions. */
export function messageVersionsAnswer(status: number, body: unknown): MessageVersionsAnswer {
  const record = asRecord(body);
  if (status < 200 || status >= 300 || !record) return refusal(status, body);
  const questions = (Array.isArray(record.questions) ? record.questions : [])
    .map(readQuestion)
    .filter((q): q is QuestionVersionsView => q !== null);
  return { ok: true, supported: true, questions };
}

/** The agent's answer to POST switch-version. */
export function switchVersionAnswer(status: number, body: unknown): SwitchVersionAnswer {
  const record = asRecord(body);
  if (status < 200 || status >= 300 || !record) return refusal(status, body);
  const left = record.versions;
  return {
    ok: true,
    supported: true,
    text: typeof record.text === "string" ? record.text : "",
    versions: typeof left === "number" && Number.isInteger(left) && left >= 0 ? left : 0,
  };
}
