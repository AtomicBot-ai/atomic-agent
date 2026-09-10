import type { SessionState } from "./session-state.js";

/**
 * Column-level view of one stored session: what a list needs to render
 * a row without parsing the transcript. `SessionStore.listSummaries`
 * projects it straight out of SQL; `summarizeSessionState` is the same
 * projection over an in-memory state, so a stub can stand in for the
 * store and a test can check the two agree.
 */
export interface SessionSummary {
  id: string;
  workingDir: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  stepCount: number;
  /**
   * Text of the first `user` turn, which is what names a session. `null`
   * when nobody has spoken to it yet — an empty string is still a prompt
   * and keeps the row visible.
   */
  firstPrompt: string | null;
  /** `metadata.importedFrom` for sessions migrated from another agent. */
  importedFrom: string | null;
}

export function summarizeSessionState(state: SessionState): SessionSummary {
  const firstUser = state.turns.find((turn) => turn.kind === "user");
  const importedFrom = state.metadata?.importedFrom;
  return {
    id: state.id,
    workingDir: state.workingDir,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    turnCount: state.turnCount,
    stepCount: state.stepCount,
    firstPrompt: firstUser?.kind === "user" ? firstUser.text : null,
    importedFrom: typeof importedFrom === "string" ? importedFrom : null,
  };
}
