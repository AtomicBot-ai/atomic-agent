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
  /**
   * How deep this worker sits under the operator session: the operator
   * session is 0, a worker it spawns is 1, a worker spawned by a worker
   * is its parent's depth + 1 (`childFusionWorkerDepth`). Optional on
   * input, where it defaults to 1; always present on a stamped record and
   * on what `readFusionWorkerMeta` returns (ATO-1666).
   */
  depth?: number;
}

/** A worker stamp as read back: the depth is always resolved. */
export type StampedFusionWorkerMeta = Required<FusionWorkerMeta>;

/** Depth of a worker spawned straight from a real (operator) session. */
export const FUSION_WORKER_DEFAULT_DEPTH = 1;

function isValidDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
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
  const { parentSessionId, taskId, depth } = input.meta;
  const stamp: StampedFusionWorkerMeta = {
    parentSessionId,
    taskId,
    depth: isValidDepth(depth) ? depth : FUSION_WORKER_DEFAULT_DEPTH,
  };
  return createEmptySessionState({
    id: `${FUSION_WORKER_ID_PREFIX}${randomUUID()}`,
    workingDir: input.workingDir,
    metadata: { [FUSION_WORKER_METADATA_KEY]: stamp },
  });
}

/**
 * Read the worker stamp back out of session metadata. Defensive on
 * purpose, like `readSessionLlmStamp`: metadata is a free-form JSON bag,
 * so a malformed value degrades to "not a worker" — the safe direction,
 * since treating a real session as a worker would drop its save.
 * The depth is the one exception: records written before ATO-1666 have
 * none, so a missing or malformed depth reads as 1 and the record stays
 * a valid worker stamp.
 */
export function readFusionWorkerMeta(
  metadata: Record<string, unknown> | undefined,
): StampedFusionWorkerMeta | null {
  const raw = metadata?.[FUSION_WORKER_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { parentSessionId, taskId, depth } = raw as {
    parentSessionId?: unknown;
    taskId?: unknown;
    depth?: unknown;
  };
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
    return null;
  }
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  return {
    parentSessionId,
    taskId,
    depth: isValidDepth(depth) ? depth : FUSION_WORKER_DEFAULT_DEPTH,
  };
}

/**
 * The depth of the session carrying `metadata`: 0 for a real session
 * (no valid worker stamp), the stamped depth for a worker.
 */
export function readSessionDepth(
  metadata: Record<string, unknown> | undefined,
): number {
  return readFusionWorkerMeta(metadata)?.depth ?? 0;
}

/**
 * The depth a worker spawned from the session carrying `parentMetadata`
 * gets: the parent's depth + 1, so 1 under a real session.
 */
export function childFusionWorkerDepth(
  parentMetadata: Record<string, unknown> | undefined,
): number {
  return readSessionDepth(parentMetadata) + 1;
}

/** Whether `id` was minted by `createFusionWorkerSession`. */
export function isFusionWorkerSessionId(id: string): boolean {
  return id.startsWith(FUSION_WORKER_ID_PREFIX);
}

/**
 * The depth of the calling session, read from its session data. Fails
 * closed: a session whose id carries the worker prefix (`s-w-`) is at
 * least depth 1 even when its stamp is missing or broken, since only
 * `createFusionWorkerSession` mints such ids. Hiding a delegating tool
 * from workers is not the guard; this is. Both `fusion.delegate` and
 * `subagent.run` refuse a caller at depth 1 or more with it (ATO-1740).
 */
export function callerDepth(
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
): number {
  const stamped = readSessionDepth(metadata);
  return isFusionWorkerSessionId(sessionId)
    ? Math.max(stamped, FUSION_WORKER_DEFAULT_DEPTH)
    : stamped;
}
