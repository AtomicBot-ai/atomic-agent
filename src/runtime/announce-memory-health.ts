import type { AgentLoopEvent } from "../agent/agent-loop.js";
import {
  createSubcallHealthTracker,
  type MemorySubcallKind,
  type MemorySubcallOutcome,
  type SubcallHealthTracker,
} from "../memory/health/index.js";
import type { VoteRunner } from "../memory/voting/vote-runner.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

export interface MemoryHealthAnnouncer {
  /**
   * Fold one sub-call outcome in. Fire-safe: it is called from inside
   * the runners' trace hooks, and a broken sink must never cost the
   * sub-call that reported.
   */
  observe(
    sessionId: string,
    kind: MemorySubcallKind,
    outcome: MemorySubcallOutcome,
    reason?: string,
  ): void;
}

/**
 * Turns the tracker's once-per-(session, kind) warning into the three
 * places an operator looks: a warn log line, and a
 * `memory_health_warning` event on the session — which the trace
 * recorder writes as a row and the TUI renders as a warn notice.
 *
 * `emit` takes the session explicitly (bootstrap's
 * `emitAgentLoopEventFor`): reflection settles after the turn ended, and
 * the event must land on the session the sub-call ran for.
 */
export function createMemoryHealthAnnouncer(deps: {
  emit: (sessionId: string, event: AgentLoopEvent) => void;
  logger?: Pick<StructuredLogger, "warn">;
  tracker?: SubcallHealthTracker;
}): MemoryHealthAnnouncer {
  const tracker = deps.tracker ?? createSubcallHealthTracker();
  return {
    observe(sessionId, kind, outcome, reason) {
      try {
        const warning = tracker.record({
          sessionId,
          kind,
          outcome,
          ...(reason ? { reason } : {}),
        });
        if (warning === null) return;
        deps.logger?.warn("memory.health.warning", {
          sessionId,
          kind: warning.kind,
          outcome: warning.outcome,
          consecutive: warning.consecutive,
          setting: warning.setting,
          ...(warning.reason !== undefined ? { reason: warning.reason } : {}),
        });
        deps.emit(sessionId, { type: "memory_health_warning", ...warning });
      } catch {
        // Observability must never derail the sub-call — swallow.
      }
    },
  };
}

/**
 * The vote runner reports its outcome only in `run()`'s result (its
 * trace hook covers individual votes), so its health is read there.
 * Everything else passes through untouched.
 */
export function observeVoteRunnerHealth(
  runner: VoteRunner,
  announcer: MemoryHealthAnnouncer,
): VoteRunner {
  return {
    async run(input) {
      const result = await runner.run(input);
      announcer.observe(input.sessionId, "vote", result.outcome, result.reason);
      return result;
    },
    abortPending(options) {
      runner.abortPending(options);
    },
  };
}
