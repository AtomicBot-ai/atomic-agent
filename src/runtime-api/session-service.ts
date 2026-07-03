import type { SessionState, SessionStatus } from "../session/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";

/**
 * Compact session projection returned by list/create/open so the host
 * never receives the full transcript when it only needs a row summary.
 */
export interface SessionSummary {
  id: string;
  workingDir: string;
  status: SessionStatus;
  turnCount: number;
  stepCount: number;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  busy: boolean;
}

export interface SessionServiceDeps {
  createSession(input?: {
    metadata?: Record<string, unknown>;
  }): SessionState;
  sessionStore: {
    load(id: string): SessionState | null;
    listRecent(limit?: number): SessionState[];
    listByWorkingDir(workingDir: string, limit?: number): SessionState[];
    delete(id: string): void;
  };
  turnController: { isBusy(sessionId: string): boolean };
}

export interface ListSessionsInput {
  limit?: number;
  workingDir?: string;
}

export function toSessionSummary(
  state: SessionState,
  turnController: { isBusy(sessionId: string): boolean },
): SessionSummary {
  return {
    id: state.id,
    workingDir: state.workingDir,
    status: state.status,
    turnCount: state.turnCount,
    stepCount: state.stepCount,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastError: state.lastError,
    busy: turnController.isBusy(state.id),
  };
}

export function createSession(
  deps: SessionServiceDeps,
  input: { metadata?: Record<string, unknown> } = {},
): SessionSummary {
  const state = deps.createSession(
    input.metadata ? { metadata: input.metadata } : {},
  );
  return toSessionSummary(state, deps.turnController);
}

export function listSessions(
  deps: SessionServiceDeps,
  input: ListSessionsInput = {},
): SessionSummary[] {
  const limit = clampLimit(input.limit);
  const states = input.workingDir
    ? deps.sessionStore.listByWorkingDir(input.workingDir, limit)
    : deps.sessionStore.listRecent(limit);
  return states.map((s) => toSessionSummary(s, deps.turnController));
}

export function getSession(
  deps: SessionServiceDeps,
  sessionId: string,
): SessionState {
  const state = deps.sessionStore.load(sessionId);
  if (!state) {
    throw new RuntimeApiError(`session not found: ${sessionId}`, "not_found");
  }
  return state;
}

/** Load a persisted session for resume, returning its summary. */
export function openSession(
  deps: SessionServiceDeps,
  sessionId: string,
): SessionSummary {
  const state = getSession(deps, sessionId);
  return toSessionSummary(state, deps.turnController);
}

export function deleteSession(
  deps: SessionServiceDeps,
  sessionId: string,
): { deleted: boolean } {
  const existed = deps.sessionStore.load(sessionId) !== null;
  deps.sessionStore.delete(sessionId);
  return { deleted: existed };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 25;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RuntimeApiError(
      "limit must be a positive integer",
      "invalid_request",
      "limit",
    );
  }
  return Math.min(Math.floor(limit), 200);
}
