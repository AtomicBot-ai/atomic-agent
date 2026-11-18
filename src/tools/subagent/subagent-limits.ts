import {
  DEFAULT_FUSION_CLOUD_WORKERS,
  DEFAULT_FUSION_TASK_TREE_MAX_NODES,
} from "../../config/llm-run-mode-config.js";
import {
  FUSION_WORKER_DEFAULT_DEPTH,
  isFusionWorkerSessionId,
  readSessionDepth,
} from "../../session/fusion-worker-session.js";
import type { SessionState } from "../../session/session-state.js";

/**
 * The limits on `subagent.run` (ATO-1670), as named constants so they can
 * become settings later. No config key reads them yet.
 */

/**
 * How deep a subagent may sit under the operator's session. 1: only a
 * session at depth 0 (a real chat) may call the tool, so a subagent never
 * starts subagents of its own. Precedents: Claude Code subagents cannot
 * spawn subagents, and Codex multi-agent defaults to a maximum depth of 1.
 */
export const SUBAGENT_MAX_DEPTH = 1;

/**
 * Subagents one call may start. The cloud worker cap Fusion already uses
 * for how many workers run at once on a cloud leg
 * (`DEFAULT_FUSION_CLOUD_WORKERS`, 4), so one call never starts more
 * than run side by side.
 */
export const SUBAGENT_MAX_CHILDREN_PER_CALL = DEFAULT_FUSION_CLOUD_WORKERS;

/**
 * Subagents one turn may start across its calls. The task tree's node
 * cap for one fan-out (`DEFAULT_FUSION_TASK_TREE_MAX_NODES`, 24): the
 * same bound on how many worker turns one planning turn may spend.
 */
export const SUBAGENT_MAX_CHILDREN_PER_TURN = DEFAULT_FUSION_TASK_TREE_MAX_NODES;

/**
 * The depth of the calling session, read from its session data. Fails
 * closed: a session whose id carries the worker prefix (`s-w-`) is at
 * least depth 1 even when its stamp is missing or broken, since only
 * `createFusionWorkerSession` mints such ids. Hiding the tool from
 * workers is not the guard; this is.
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

/**
 * Subagents started per turn, per session. A tool sees no turn boundary,
 * only the step index, which restarts at 0 each turn; the tool runs solo,
 * so within one turn every call has a higher step index than the last.
 * A step index at or below the last one seen therefore starts a new turn.
 */
export class SubagentTurnLedger {
  private readonly bySession = new Map<string, { step: number; children: number }>();

  /** Children already started this turn on `sessionId`. */
  childrenThisTurn(sessionId: string, stepIndex: number): number {
    const seen = this.bySession.get(sessionId);
    if (seen === undefined || stepIndex <= seen.step) return 0;
    return seen.children;
  }

  /** Count `count` children starting now. */
  record(sessionId: string, stepIndex: number, count: number): void {
    const before = this.childrenThisTurn(sessionId, stepIndex);
    this.bySession.set(sessionId, { step: stepIndex, children: before + count });
  }
}

/**
 * The metadata of worker sessions this process minted, by id, so the
 * depth check reads a worker's own stamp. Worker sessions are never
 * stored, so nothing else can answer for them. Bounded: past `max`
 * entries the oldest is forgotten, which only falls back to the id
 * prefix check in `callerDepth`, never to depth 0 for a worker.
 */
export class MintedSessionMetadata {
  private readonly byId = new Map<string, Record<string, unknown>>();

  constructor(private readonly max = 512) {}

  remember(session: SessionState): SessionState {
    this.byId.set(session.id, session.metadata);
    while (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    return session;
  }

  read(sessionId: string): Record<string, unknown> | undefined {
    return this.byId.get(sessionId);
  }
}
