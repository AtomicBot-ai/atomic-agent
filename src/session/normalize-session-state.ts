import type { SessionState } from "./session-state.js";

/**
 * Fill in the fields a parsed payload may lack. Rows written before a
 * field existed, and rows imported from other agents, are missing the
 * arrays a reader iterates (`turns`, `knownFacts`, `loadedTools`) — a
 * missing array is a crash in a list, a defaulted one is an empty row.
 *
 * Throws on a payload that is not an object at all (`null`, a number):
 * there is nothing to default, and `SessionStore.readPayload` counts
 * the throw as an unreadable row.
 */
export function normalizeSessionState(raw: unknown): SessionState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("session payload is not an object");
  }
  const s = raw as SessionState;
  return {
    ...s,
    knownFacts: s.knownFacts ?? [],
    latestResult: s.latestResult ?? null,
    loadedSkills: s.loadedSkills ?? [],
    loadedTools: s.loadedTools ?? [],
    worldSnapshot: s.worldSnapshot ?? null,
    stepCount: s.stepCount ?? 0,
    turnCount: s.turnCount ?? 0,
    turns: Array.isArray(s.turns) ? s.turns : [],
    metadata: s.metadata ?? {},
    lastError: s.lastError ?? null,
  };
}
