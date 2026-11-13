/**
 * ATO-1040 — what the window may ask of a chat's goal, checked before it
 * reaches the agent (session-goal-ipc.ts). The agent decides the rest
 * (POST /api/sessions/{id}/goal, the TUI's /goal rules); this only keeps
 * the window to the four actions and the agent's bounds.
 */

export type GoalIpcRequest =
  | { ok: true; sessionId: string; body: { action: "pause" | "resume" | "clear" } | { action: "set"; criteria: string[]; maxRounds?: number } }
  | { ok: false; error: string };

/** The agent's bounds (src/agent/goal/goal-types.ts). */
export const GOAL_IPC_MAX_CRITERIA = 20;
export const GOAL_IPC_MAX_ROUNDS = 50;
const CRITERION_MAX_CHARS = 2_000;

export function goalSessionIdOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 200 && !/[\r\n\x00/]/.test(raw) ? raw : null;
}

export function goalIpcRequest(payload: unknown): GoalIpcRequest {
  const { sessionId, body } = (payload ?? {}) as { sessionId?: unknown; body?: unknown };
  const id = goalSessionIdOf(sessionId);
  if (!id) return { ok: false, error: "No chat to set a goal on yet" };
  const b = (body ?? {}) as { action?: unknown; criteria?: unknown; maxRounds?: unknown };
  if (b.action === "pause" || b.action === "resume" || b.action === "clear") {
    return { ok: true, sessionId: id, body: { action: b.action } };
  }
  if (b.action !== "set") return { ok: false, error: "Unknown goal action" };
  if (!Array.isArray(b.criteria)) return { ok: false, error: "A goal needs its criteria" };
  const criteria = b.criteria
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().slice(0, CRITERION_MAX_CHARS))
    .filter((c) => c.length > 0);
  if (criteria.length === 0) return { ok: false, error: "A goal needs at least one criterion" };
  if (criteria.length > GOAL_IPC_MAX_CRITERIA) return { ok: false, error: `At most ${GOAL_IPC_MAX_CRITERIA} criteria` };
  const rounds = b.maxRounds;
  if (rounds !== undefined && (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1 || rounds > GOAL_IPC_MAX_ROUNDS)) {
    return { ok: false, error: `Rounds: a whole number from 1 to ${GOAL_IPC_MAX_ROUNDS}` };
  }
  return {
    ok: true,
    sessionId: id,
    body: { action: "set", criteria, ...(typeof rounds === "number" ? { maxRounds: rounds } : {}) },
  };
}

/** An agent's refusal in the window's words: an older agent has no goal routes. */
export function goalErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/^no route for /i.test(text)) return "This agent has no goal mode yet. Update Atomic Agent.";
  return text || "The agent did not answer";
}
