import {
  appendTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

export type SessionStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_llm"
  | "completed"
  | "failed"
  | "cancelled";

export interface KnownFact {
  text: string;
  source?: string;
}

export interface LatestResult {
  tool: string;
  status: "ok" | "error";
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Body of a skill (SKILL.md without frontmatter) loaded into the session
 * through `skill.view`. Kept in session state so the LLM does not pay the
 * token cost of re-loading the same skill on every step.
 */
export interface LoadedSkillBody {
  name: string;
  version: string;
  body: string;
  loadedAt: number;
}

/**
 * Compact snapshot of the current world observable to the agent (e.g. the
 * browser ARIA tree). Kept small and deterministic so it can live in the
 * prompt tail without exploding the token budget.
 */
export interface WorldSnapshot {
  kind: "browser" | "none";
  digest: string;
  text: string;
  capturedAt: number;
}

export interface SessionState {
  id: string;
  /** Working directory for OS tools and relative paths. */
  workingDir: string;
  status: SessionStatus;
  knownFacts: KnownFact[];
  latestResult: LatestResult | null;
  loadedSkills: LoadedSkillBody[];
  worldSnapshot: WorldSnapshot | null;
  stepCount: number;
  /** Number of completed macro-turns (user → 0..N tools → reply). */
  turnCount: number;
  /** Full conversation transcript in chronological order. */
  turns: ConversationTurn[];
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

export function createEmptySessionState(params: {
  id: string;
  workingDir: string;
  metadata?: Record<string, unknown>;
}): SessionState {
  const now = Date.now();
  return {
    id: params.id,
    workingDir: params.workingDir,
    status: "pending",
    knownFacts: [],
    latestResult: null,
    loadedSkills: [],
    worldSnapshot: null,
    stepCount: 0,
    turnCount: 0,
    turns: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
    metadata: params.metadata ?? {},
  };
}

export function appendFact(state: SessionState, fact: KnownFact): SessionState {
  return {
    ...state,
    knownFacts: [...state.knownFacts, fact],
    updatedAt: Date.now(),
  };
}

export function recordLatestResult(
  state: SessionState,
  result: LatestResult,
): SessionState {
  return { ...state, latestResult: result, updatedAt: Date.now() };
}

export function recordLoadedSkill(
  state: SessionState,
  entry: LoadedSkillBody,
): SessionState {
  const others = state.loadedSkills.filter((s) => s.name !== entry.name);
  return {
    ...state,
    loadedSkills: [...others, entry],
    updatedAt: Date.now(),
  };
}

export function recordWorldSnapshot(
  state: SessionState,
  snapshot: WorldSnapshot,
): SessionState {
  return { ...state, worldSnapshot: snapshot, updatedAt: Date.now() };
}

/**
 * Append a conversation turn and bump `updatedAt`. The caller is expected
 * to persist the new state through `SessionStore.save` — we return a fresh
 * object instead of mutating so reducer-style code stays pure.
 */
export function recordTurn(
  state: SessionState,
  turn: ConversationTurn,
): SessionState {
  return {
    ...state,
    turns: appendTurn(state.turns, turn),
    updatedAt: Date.now(),
  };
}

export function incrementTurnCount(state: SessionState): SessionState {
  return { ...state, turnCount: state.turnCount + 1, updatedAt: Date.now() };
}
