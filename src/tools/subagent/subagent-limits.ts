import {
  DEFAULT_FUSION_CLOUD_WORKERS,
  DEFAULT_FUSION_TASK_TREE_MAX_NODES,
} from "../../config/llm-run-mode-config.js";
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
 * The caller's depth now lives with the worker stamp it reads
 * (`src/session/fusion-worker-session.ts`), so `fusion.delegate` can use
 * it without depending on this folder (ATO-1740). Re-exported here so
 * `subagent.run` and its tests keep their import.
 */
export { callerDepth } from "../../session/fusion-worker-session.js";

/** Where a call sits: its turn (when the loop names it) and its step. */
export interface SubagentTurnPosition {
  /** `ToolContext.turnId`: one value per agent turn. */
  turnId?: string;
  /** `ToolContext.stepIndex`. */
  stepIndex: number;
}

/**
 * Subagents started per turn, per session. Keyed on the turn id the agent
 * loop hands every call (`ToolContext.turnId`): a call in another turn
 * starts from 0. Only a call without a turn id (outside the agent loop)
 * falls back to step edges: the step index restarts at 0 each turn and
 * the tool runs solo, so a step at or below the last one seen is a new
 * turn. Bounded: one entry per session (a new turn replaces the old
 * one), and past `maxSessions` sessions the oldest is forgotten.
 */
export class SubagentTurnLedger {
  private readonly bySession = new Map<
    string,
    { turnId: string | undefined; step: number; children: number }
  >();

  constructor(private readonly maxSessions = 256) {}

  /** Children already started this turn on `sessionId`. */
  childrenThisTurn(sessionId: string, at: SubagentTurnPosition): number {
    const seen = this.bySession.get(sessionId);
    if (seen === undefined) return 0;
    if (at.turnId !== undefined || seen.turnId !== undefined) {
      return at.turnId === seen.turnId ? seen.children : 0;
    }
    return at.stepIndex <= seen.step ? 0 : seen.children;
  }

  /** Count `count` children starting now. */
  record(sessionId: string, at: SubagentTurnPosition, count: number): void {
    const before = this.childrenThisTurn(sessionId, at);
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, {
      turnId: at.turnId,
      step: at.stepIndex,
      children: before + count,
    });
    while (this.bySession.size > this.maxSessions) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
  }

  /** Sessions tracked now (for tests of the bound). */
  get size(): number {
    return this.bySession.size;
  }
}

/**
 * The metadata of worker sessions this process minted, by id, so the
 * depth check reads a worker's own stamp. Worker sessions are never
 * stored, so nothing else can answer for them. Bounded: past `max`
 * entries the oldest is forgotten, which only falls back to the id
 * prefix check in `callerDepth`, never to depth 0 for a worker.
 *
 * With `SUBAGENT_MAX_DEPTH` at 1 this changes no outcome yet: every
 * minted worker id carries the `s-w-` prefix, so the prefix check alone
 * already refuses it. The stamp only decides once the maximum depth is
 * above 1, where a depth-1 child may call and a depth-2 one may not.
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
