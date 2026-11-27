/**
 * ATO-2257: what the task board may send to the agent's
 * `POST /api/tasks/{id}/board`, checked in main before it leaves the
 * window. Pure (no electron) so test/workboard.test.mjs loads it from
 * the build. The agent checks the same rules again (src/tasks/
 * task-board-lanes.ts); this keeps a broken or hostile renderer call
 * from reaching it with anything else.
 */

export const WORKBOARD_LANES = ["todo", "doing", "review", "blocked", "done"] as const;
export type WorkboardLane = (typeof WORKBOARD_LANES)[number];

/** The agent's own cap on a card's note. */
export const WORKBOARD_NOTE_MAX = 2_000;
/** An agent profile name, as agent-profiles/agent-profile.ts allows it. */
const ASSIGNEE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type WorkboardMove =
  | { ok: true; body: { lane?: WorkboardLane | null; note?: string | null; assignee?: string | null } }
  | { ok: false; error: string };

/**
 * Keep only `lane`, `note` and `assignee`, each checked; `null` clears
 * a field. At least one of them must be there.
 */
export function cleanBoardMove(raw: unknown): WorkboardMove {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "nothing to change" };
  const src = raw as Record<string, unknown>;
  const body: { lane?: WorkboardLane | null; note?: string | null; assignee?: string | null } = {};
  if (src.lane !== undefined) {
    if (src.lane === null) body.lane = null;
    else if (typeof src.lane === "string" && (WORKBOARD_LANES as readonly string[]).includes(src.lane)) {
      body.lane = src.lane as WorkboardLane;
    } else return { ok: false, error: "unknown lane" };
  }
  if (src.note !== undefined) {
    if (src.note === null) body.note = null;
    else if (typeof src.note === "string" && src.note.length <= WORKBOARD_NOTE_MAX) body.note = src.note;
    else return { ok: false, error: `a note is text of at most ${WORKBOARD_NOTE_MAX} characters` };
  }
  if (src.assignee !== undefined) {
    const value = typeof src.assignee === "string" ? src.assignee.trim() : src.assignee;
    if (value === null || value === "") body.assignee = null;
    else if (typeof value === "string" && ASSIGNEE.test(value)) body.assignee = value;
    else return { ok: false, error: "an assignee is a profile name (lowercase letters, digits, - and _)" };
  }
  if (Object.keys(body).length === 0) return { ok: false, error: "nothing to change" };
  return { ok: true, body };
}
