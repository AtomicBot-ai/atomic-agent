import { randomUUID } from "node:crypto";
import { createEmptySessionState, type SessionState } from "./session-state.js";

/**
 * Ephemeral sessions for fusion workers.
 *
 * In fusion mode a cloud orchestrator turn fans subtasks out to local
 * model workers running concurrently in the same process. Each worker
 * needs a `SessionState` of its own — the turn controller's per-session
 * FIFO, slot affinity, approvals and steering are all keyed by session
 * id — but nothing about it is the operator's: it is never saved, never
 * listed, never reflected on. The orchestrator reads the worker's reply
 * once and discards the state. The metadata stamp below is how the
 * runtime tells such a session apart from a real one on every path that
 * would otherwise persist or trace it.
 */

/** Reserved `SessionState.metadata` key the worker stamp lives under. */
export const FUSION_WORKER_METADATA_KEY = "fusionWorker";

/** Worker session ids start with this; a real session's start with `s-`. */
export const FUSION_WORKER_ID_PREFIX = "s-w-";

export interface FusionWorkerMeta {
  /** The session whose orchestrator turn spawned this worker. */
  parentSessionId: string;
  /** The orchestrator's task id for this subtask (its own bookkeeping). */
  taskId: string;
}

/**
 * Build a worker session in memory. Deliberately NOT persisted here and
 * not by any caller: `executeTurn` skips `sessionStore.save` for a
 * session carrying the stamp, so the id never reaches the session list.
 */
export function createFusionWorkerSession(input: {
  workingDir: string;
  meta: FusionWorkerMeta;
}): SessionState {
  return createEmptySessionState({
    id: `${FUSION_WORKER_ID_PREFIX}${randomUUID()}`,
    workingDir: input.workingDir,
    metadata: { [FUSION_WORKER_METADATA_KEY]: { ...input.meta } },
  });
}

/**
 * Read the worker stamp back out of session metadata. Defensive on
 * purpose, like `readSessionLlmStamp`: metadata is a free-form JSON bag,
 * so a malformed value degrades to "not a worker" — the safe direction,
 * since treating a real session as a worker would drop its save.
 */
export function readFusionWorkerMeta(
  metadata: Record<string, unknown> | undefined,
): FusionWorkerMeta | null {
  const raw = metadata?.[FUSION_WORKER_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { parentSessionId, taskId } = raw as {
    parentSessionId?: unknown;
    taskId?: unknown;
  };
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
    return null;
  }
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  return { parentSessionId, taskId };
}

/** Whether `id` was minted by `createFusionWorkerSession`. */
export function isFusionWorkerSessionId(id: string): boolean {
  return id.startsWith(FUSION_WORKER_ID_PREFIX);
}
